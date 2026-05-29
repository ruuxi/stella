/**
 * Renderer-side crash/error reporting into the shared on-disk error log.
 *
 * Forwards uncaught renderer errors, unhandled promise rejections, and
 * React error-boundary catches to the main process, which scrubs and
 * writes them to `~/.stella/logs/<rootHash>/error-*.txt` alongside main +
 * worker crashes. Metadata only (message + stack + source) — never UI
 * content or app state.
 *
 * Guarded for hosts without `electronAPI` (e.g. the mobile tunnel webview),
 * and throttled/deduped so an error loop can't flood the log.
 */

type RendererErrorPayload = {
  message?: string
  stack?: string
  source?: string
  kind?: 'window.onerror' | 'unhandledrejection' | 'react'
}

const MAX_REPORTS_PER_SESSION = 50
const DEDUP_WINDOW_MS = 5_000

let reportCount = 0
const recent = new Map<string, number>()

export const reportRendererError = (payload: RendererErrorPayload): void => {
  const api = window.electronAPI?.system
  if (!api?.reportError) return
  if (reportCount >= MAX_REPORTS_PER_SESSION) return

  const signature = `${payload.kind ?? ''}:${payload.message ?? ''}:${
    payload.source ?? ''
  }`
  const now = Date.now()
  const last = recent.get(signature)
  if (last != null && now - last < DEDUP_WINDOW_MS) return
  recent.set(signature, now)

  reportCount += 1
  try {
    api.reportError(payload)
  } catch {
    // Reporting must never throw into app code.
  }
}

let installed = false

export const installRendererErrorReporting = (): void => {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    reportRendererError({
      kind: 'window.onerror',
      message: event.message || event.error?.message,
      stack: event.error?.stack,
      source: event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : undefined,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    reportRendererError({
      kind: 'unhandledrejection',
      message:
        reason instanceof Error ? reason.message : String(reason ?? 'unknown'),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  })
}
