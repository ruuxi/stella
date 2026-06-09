import { runNativeHelper } from './native-helper.js'
import { hasMacPermission } from './utils/macos-permissions.js'

// UIA-only is quick; the clipboard fallback adds a synthetic Ctrl+C plus a
// short clipboard poll, so it needs a larger ceiling. The helper self-bounds
// under both via an internal watchdog, so we rarely wait the whole budget --
// these are just the process-kill safety nets.
const UIA_ONLY_TIMEOUT_MS = 1000
const CLIPBOARD_FALLBACK_TIMEOUT_MS = 1800

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

  // The synthetic-copy fallback is the expensive, side-effectful pass, so it's
  // opt-in: callers (e.g. the selection watcher) only enable it after a real
  // drag, and the cheap UIA/AX-only probe runs otherwise. It must stay reachable
  // on Windows too — Chromium/Electron/custom text views don't expose
  // `TextPattern.GetSelection`, so UIA-only returns nothing there and the global
  // "Ask Stella" pill never appears. Spawn frequency is bounded by the win32
  // governor + circuit breaker in native-helper.ts, not by disabling it here.
  const clipboardAllowed = options?.allowClipboardFallback !== false
  const args = clipboardAllowed ? [] : ['--no-clipboard-fallback']

  const stdout = await runNativeHelper('selected_text', args, {
    timeout: clipboardAllowed
      ? CLIPBOARD_FALLBACK_TIMEOUT_MS
      : UIA_ONLY_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
  })
  if (stdout == null) return null
  return parseSelectedTextStdout(stdout)
}
