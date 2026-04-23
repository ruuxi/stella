import { runNativeHelper } from './native-helper.js'
import { hasMacPermission } from './utils/macos-permissions.js'

const TIMEOUT_MS = 1000

export type SelectedTextRect = {
  x: number
  y: number
  width: number
  height: number
}

export type SelectedTextResult = {
  text: string
  /** Screen-space bounds of the selection if the AX/UIA backend reported them. */
  rect?: SelectedTextRect
}

/**
 * Initialize selected text process (no-op — native binary needs no init)
 */
export const initSelectedTextProcess = (): void => {}

/**
 * Cleanup selected text process (no-op — native binary needs no cleanup)
 */
export const cleanupSelectedTextProcess = (): void => {}

/**
 * Parse the helper's stdout into a structured result.
 *
 * Current binaries emit a single JSON line:
 *   {"text":"...","rect":{"x":1,"y":2,"w":3,"h":4}}
 *   {"text":"..."}
 *   {}
 *
 * Older binaries (pre-rebuild) emit just the raw selected string. We treat
 * any non-JSON output as backward-compat text-only result.
 */
const parseSelectedTextStdout = (raw: string): SelectedTextResult | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        text?: unknown
        rect?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
      }
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
      if (!text) return null

      const rect = parsed.rect
      const hasRect =
        rect &&
        typeof rect.x === 'number' &&
        typeof rect.y === 'number' &&
        typeof rect.w === 'number' &&
        typeof rect.h === 'number' &&
        rect.w > 0 &&
        rect.h > 0
      if (hasRect) {
        return {
          text,
          rect: {
            x: rect.x as number,
            y: rect.y as number,
            width: rect.w as number,
            height: rect.h as number,
          },
        }
      }
      return { text }
    } catch {
      // Fall through to text-only fallback for malformed JSON.
    }
  }

  return { text: trimmed }
}

export type GetSelectedTextOptions = {
  /**
   * When false, the macOS helper skips its synthetic-Cmd+C pasteboard
   * fallback for apps that don't expose `AXSelectedText` (Discord,
   * Slack, terminals, custom-drawn text views). Use the AX-only pass
   * for cheap "did the user select anything?" probes; only allow the
   * pasteboard fallback when you're confident the user just dragged
   * to select (otherwise every click would round-trip the clipboard).
   */
  allowClipboardFallback?: boolean
}

/**
 * Get the currently selected text + (when available) its screen bounds.
 * Uses UI Automation TextPattern.GetSelection (Windows) or AXSelectedText
 * + AXBoundsForRange (macOS), with an opt-in pasteboard fallback on
 * macOS for apps that don't expose `AXSelectedText` at all.
 *
 * Returns null when nothing is selected, the helper isn't installed, or
 * the user hasn't granted Accessibility permission.
 */
export const getSelectedText = async (
  options?: GetSelectedTextOptions,
): Promise<SelectedTextResult | null> => {
  if (!hasMacPermission('accessibility')) return null

  const args = options?.allowClipboardFallback === false
    ? ['--no-clipboard-fallback']
    : []

  const stdout = await runNativeHelper('selected_text', args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 512 * 1024,
  })
  if (stdout == null) return null
  return parseSelectedTextStdout(stdout)
}
