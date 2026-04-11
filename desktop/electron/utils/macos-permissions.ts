import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { systemPreferences } from 'electron'
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
const MIC_PERMISSION_BUNDLE_IDS = [
  'com.stella.launcher',
  'com.stella.app',
  'com.github.Electron',
] as const

const checkAccessibility = (prompt: boolean): boolean =>
  systemPreferences.isTrustedAccessibilityClient(prompt)

const checkScreenRecordingFallback = (): boolean =>
  systemPreferences.getMediaAccessStatus('screen') === 'granted'

const checkScreenRecording = (): boolean => {
  if (process.platform !== 'darwin') {
    return checkScreenRecordingFallback()
  }
  const mod = getScreenCapturePermissions()
  if (!mod) {
    return checkScreenRecordingFallback()
  }

  try {
    return mod.hasScreenCapturePermission()
  } catch {
    return checkScreenRecordingFallback()
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const requestScreenRecording = async (): Promise<boolean> => {
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

export const resetMacMicrophonePermissions = async (): Promise<boolean> => {
  if (process.platform !== 'darwin') return false

  const results = await Promise.all(
    MIC_PERMISSION_BUNDLE_IDS.map((bundleId) =>
      runExecFile('tccutil', ['reset', 'Microphone', bundleId]),
    ),
  )
  return results.some(Boolean)
}

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
