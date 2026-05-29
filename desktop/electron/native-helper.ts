import { execFile } from 'child_process'
import { resolveNativeHelperPath } from './native-helper-path.js'
import { getFileLogger } from '../../runtime/observability/file-logger.js'

type RunNativeHelperOptions = {
  timeout: number
  encoding?: BufferEncoding
  maxBuffer?: number
  onError?: (error: Error) => void
}

// Some helpers (e.g. window_info) run on cursor-move loops. We only log on
// failure, but a consistently-failing helper could still flap fast — throttle
// to one log per helper per window so a broken helper can't spam the file.
const FAILURE_LOG_THROTTLE_MS = 30_000
const lastFailureLogAt = new Map<string, number>()

export const runNativeHelper = (
  helperName: string,
  args: string[],
  options: RunNativeHelperOptions,
): Promise<string | null> => {
  const helperPath = resolveNativeHelperPath(helperName)
  if (!helperPath) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    execFile(
      helperPath,
      args,
      {
        timeout: options.timeout,
        encoding: options.encoding ?? 'utf8',
        maxBuffer: options.maxBuffer,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const now = Date.now()
          const last = lastFailureLogAt.get(helperName) ?? 0
          if (now - last >= FAILURE_LOG_THROTTLE_MS) {
            lastFailureLogAt.set(helperName, now)
            getFileLogger()?.warn('native.helper.failed', {
              helper: helperName,
              code: (error as NodeJS.ErrnoException).code,
              killed: (error as { killed?: boolean }).killed,
              error,
            })
          }
          options.onError?.(error)
          resolve(null)
          return
        }
        resolve(typeof stdout === 'string' ? stdout.trim() || null : null)
      },
    )
  })
}
