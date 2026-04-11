import { createRequire } from 'node:module'
import { systemPreferences } from 'electron'
import { runNativeHelper } from '../native-helper.js'

const require = createRequire(import.meta.url)
type ScreenCapturePermissionsModule = {
  hasScreenCapturePermission: () => boolean
  hasPromptedForPermission: () => boolean
  openSystemPreferences: () => Promise<void>
}
const screenCapturePermissions = require('mac-screen-capture-permissions') as ScreenCapturePermissionsModule

export type MacPermissionKind = 'accessibility' | 'screen'
export type MacPermissionSettingsKind =
  | MacPermissionKind
  | 'full-disk-access'
  | 'microphone'

const permissionCache = new Map<MacPermissionKind, boolean>()

const checkAccessibility = (prompt: boolean): boolean =>
  systemPreferences.isTrustedAccessibilityClient(prompt)

const checkScreenRecording = (): boolean =>
  process.platform === 'darwin'
    ? screenCapturePermissions.hasScreenCapturePermission()
    : systemPreferences.getMediaAccessStatus('screen') === 'granted'

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
