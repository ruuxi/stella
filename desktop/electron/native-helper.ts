import { execFile } from 'child_process'
import { resolveNativeHelperPath } from './native-helper-path.js'

type RunNativeHelperOptions = {
  timeout: number
  encoding?: BufferEncoding
  maxBuffer?: number
  onError?: (error: Error) => void
}

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
          options.onError?.(error)
          resolve(null)
          return
        }
        resolve(typeof stdout === 'string' ? stdout.trim() || null : null)
      },
    )
  })
}
