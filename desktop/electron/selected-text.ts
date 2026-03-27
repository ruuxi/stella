import { runNativeHelper } from './native-helper.js'

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
  return runNativeHelper('selected_text', [], {
    timeout: TIMEOUT_MS,
    maxBuffer: 512 * 1024,
  })
}
