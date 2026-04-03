import { desktopCapturer, systemPreferences } from 'electron'

export type MacPermissionKind = 'accessibility' | 'screen' | 'microphone'

const permissionCache = new Map<MacPermissionKind, boolean>()

const checkAccessibility = (prompt: boolean): boolean =>
  systemPreferences.isTrustedAccessibilityClient(prompt)

const checkScreenRecording = (): boolean =>
  systemPreferences.getMediaAccessStatus('screen') === 'granted'

const checkMicrophone = (): boolean =>
  systemPreferences.getMediaAccessStatus('microphone') === 'granted'

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
    case 'microphone':
      granted = checkMicrophone()
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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Request all macOS permissions upfront so the user sees all dialogs at once
 * instead of progressively as features activate.
 */
export const requestAllMacPermissions = async (): Promise<void> => {
  if (process.platform !== 'darwin') return

  // 1. Accessibility — opens System Preferences prompt
  if (!checkAccessibility(false)) {
    checkAccessibility(true)
    await delay(500)
  }
  permissionCache.set('accessibility', checkAccessibility(false))

  // 2. Screen Recording — no direct prompt API; trigger via desktopCapturer
  if (!checkScreenRecording()) {
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    } catch {}
    await delay(500)
  }
  permissionCache.set('screen', checkScreenRecording())

  // 3. Microphone — shows native permission dialog
  if (!checkMicrophone()) {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      permissionCache.set('microphone', granted)
    } catch {
      permissionCache.set('microphone', false)
    }
  } else {
    permissionCache.set('microphone', true)
  }
}
