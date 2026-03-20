import { execFile } from 'child_process'
import { getWindowInfoAtPoint } from './window-capture.js'
import { resolveNativeHelperPath } from './native-helper-path.js'

const TIMEOUT_MS = 6000
const MAX_TEXT_LENGTH = 16000

/**
 * Extract visible text content from the window at the given screen coordinates.
 *
 * Uses the native window_text helper binary which:
 * 1. Tries TextPattern for editors/document viewers
 * 2. Column-aware spatial filter: finds content column under cursor,
 *    extracts text from that column (avoids sidebars, navbars, etc.)
 * 3. Falls back to full-window text with role filtering
 */
export async function getWindowText(
  x: number,
  y: number,
  options?: { excludePids?: number[] },
): Promise<{ text: string; title: string; app: string } | null> {
  const windowInfo = await getWindowInfoAtPoint(x, y, options)
  if (!windowInfo) return null

  let text = await extractWindowText(windowInfo.pid, x, y)
  if (!text) return null

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH)
  }

  return { text, title: windowInfo.title, app: windowInfo.process }
}

function extractWindowText(pid: number, x: number, y: number): Promise<string | null> {
  const helperPath = resolveNativeHelperPath('window_text')
  if (!helperPath) return Promise.resolve(null)

  return new Promise((resolve) => {
    execFile(
      helperPath,
      [String(pid), String(x), String(y)],
      {
        timeout: TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
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
