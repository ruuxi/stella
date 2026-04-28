import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { desktopCapturer, systemPreferences } from 'electron'
import { runNativeHelper } from '../native-helper.js'

type ScreenCapturePermissionsModule = {
  hasScreenCapturePermission: () => boolean
  hasPromptedForPermission: () => boolean
  openSystemPreferences: () => Promise<void>
}

let _screenCapturePermissions: ScreenCapturePermissionsModule | null = null
const getScreenCapturePermissions = (): ScreenCapturePermissionsModule | null => {
  if (_screenCapturePermissions) return _screenCapturePermissions
  try {
    const require = createRequire(import.meta.url)
    _screenCapturePermissions = require('mac-screen-capture-permissions') as ScreenCapturePermissionsModule
  } catch {
    // Native module not available; fall back to Electron APIs.
  }
  return _screenCapturePermissions
}

export type MacPermissionKind = 'accessibility' | 'screen'
export type MacPermissionSettingsKind =
  | MacPermissionKind
  | 'full-disk-access'
  | 'microphone'
export type MicrophonePermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

const permissionCache = new Map<MacPermissionKind, boolean>()
const STELLA_BUNDLE_IDS = ['com.stella.app', 'com.github.Electron'] as const

const TCC_SERVICE_BY_KIND: Record<
  'accessibility' | 'screen' | 'microphone',
  string
> = {
  accessibility: 'Accessibility',
  screen: 'ScreenCapture',
  microphone: 'Microphone',
}

const checkAccessibility = (prompt: boolean): boolean =>
  systemPreferences.isTrustedAccessibilityClient(prompt)

const checkScreenRecordingViaElectron = (): boolean =>
  systemPreferences.getMediaAccessStatus('screen') === 'granted'

const checkScreenRecordingViaNativeModule = (): boolean | null => {
  const mod = getScreenCapturePermissions()
  if (!mod) return null
  try {
    return mod.hasScreenCapturePermission()
  } catch {
    return null
  }
}

const checkScreenRecording = (): boolean => {
  if (process.platform !== 'darwin') {
    return checkScreenRecordingViaElectron()
  }
  // Electron's getMediaAccessStatus is TCC-backed and reflects newly granted
  // permissions immediately; the native module's CGPreflightScreenCaptureAccess
  // is per-process and can keep reporting "denied" until the app is relaunched.
  // OR them so a fresh grant flips us to "granted" without a restart.
  if (checkScreenRecordingViaElectron()) return true
  return checkScreenRecordingViaNativeModule() === true
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Touch desktopCapturer from the Electron main process so macOS records the
 * Stella.app bundle (not a child helper) as a screen-recording client. Without
 * this, fresh installs may never show up in System Settings → Screen Recording.
 */
const registerStellaForScreenRecording = async () => {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
  } catch {
    // If we don't yet have access this can throw; the side-effect of registering
    // the bundle in TCC is what matters and that happens regardless.
  }
}

const requestScreenRecording = async (): Promise<boolean> => {
  await registerStellaForScreenRecording()

  const result = await runNativeHelper('screen_permission', ['request'], {
    timeout: 10_000,
  })

  if (result === 'granted') {
    return true
  }

  await delay(300)
  return checkScreenRecording()
}

const normalizeMicrophonePermissionStatus = (
  value: string,
): MicrophonePermissionStatus => {
  switch (value) {
    case 'not-determined':
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'unknown':
      return value
    default:
      return 'unknown'
  }
}

const runExecFile = (file: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: 5000,
        windowsHide: true,
      },
      (error) => {
        resolve(!error)
      },
    )
  })

export const getMicrophonePermissionStatus = (): MicrophonePermissionStatus => {
  try {
    return normalizeMicrophonePermissionStatus(
      systemPreferences.getMediaAccessStatus('microphone'),
    )
  } catch {
    return 'unknown'
  }
}

export type ResettableMacPermissionKind =
  | 'accessibility'
  | 'screen'
  | 'microphone'

export const resetMacPermission = async (
  kind: ResettableMacPermissionKind,
): Promise<boolean> => {
  if (process.platform !== 'darwin') return false

  const service = TCC_SERVICE_BY_KIND[kind]
  const results = await Promise.all(
    STELLA_BUNDLE_IDS.map((bundleId) =>
      runExecFile('tccutil', ['reset', service, bundleId]),
    ),
  )
  const ok = results.some(Boolean)
  if (ok && (kind === 'accessibility' || kind === 'screen')) {
    permissionCache.delete(kind)
  }
  return ok
}

export const resetMacMicrophonePermissions = (): Promise<boolean> =>
  resetMacPermission('microphone')

export const hasMacPermission = (kind: MacPermissionKind, prompt = false): boolean => {
  if (process.platform !== 'darwin') return true

  const cached = permissionCache.get(kind)
  if (cached) return true

  let granted: boolean
  switch (kind) {
    case 'accessibility':
      granted = checkAccessibility(prompt)
      break
    case 'screen':
      granted = checkScreenRecording()
      break
  }

  if (granted) {
    permissionCache.set(kind, true)
  }

  return granted
}

export const clearPermissionCache = (kind?: MacPermissionKind) => {
  if (kind) {
    permissionCache.delete(kind)
  } else {
    permissionCache.clear()
  }
}

export type PermissionRequestResult = {
  granted: boolean
  alreadyGranted: boolean
}

/**
 * Trigger the native macOS permission prompt for a single permission kind.
 * Returns whether the permission is now granted.
 */
export const requestMacPermission = async (kind: MacPermissionKind): Promise<PermissionRequestResult> => {
  if (process.platform !== 'darwin') return { granted: true, alreadyGranted: true }

  clearPermissionCache(kind)

  switch (kind) {
    case 'accessibility': {
      if (checkAccessibility(false)) return { granted: true, alreadyGranted: true }
      checkAccessibility(true)
      await delay(300)
      const granted = checkAccessibility(false)
      if (granted) permissionCache.set('accessibility', true)
      return { granted, alreadyGranted: false }
    }
    case 'screen': {
      if (checkScreenRecording()) return { granted: true, alreadyGranted: true }
      const granted = await requestScreenRecording()
      if (granted) permissionCache.set('screen', true)
      return { granted, alreadyGranted: false }
    }
  }
}
