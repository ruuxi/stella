import { execFile } from 'child_process'
import { resolveNativeHelperPath } from './native-helper-path.js'

const TIMEOUT_MS = 1000

/**
 * Initialize selected text process (no-op — native binary needs no init)
 */
export const initSelectedTextProcess = (): void => {}

/**
 * Cleanup selected text process (no-op — native binary needs no cleanup)
 */
export const cleanupSelectedTextProcess = (): void => {}

/**
 * Get currently selected text using the native selected_text binary.
 * Uses UI Automation TextPattern.GetSelection (Windows) or AXSelectedText (macOS).
 */
export const getSelectedText = async (): Promise<string | null> => {
  const helperPath = resolveNativeHelperPath('selected_text')
  if (!helperPath) return null

  return new Promise((resolve) => {
    execFile(
      helperPath,
      [],
      { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 512 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const text = stdout.trim()
        resolve(text || null)
      },
    )
  })
}
