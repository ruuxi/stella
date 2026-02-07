/**
 * Main-thread API for sending source to the compiler Web Worker.
 * Returns Promise<{ code: string } | { error: string }>.
 */

type CompileResult = { code: string; error?: undefined } | { error: string; code?: undefined }
type PendingRequest = { resolve: (result: CompileResult) => void; timer: ReturnType<typeof setTimeout> }

let worker: Worker | null = null
let requestId = 0
const pending = new Map<string, PendingRequest>()

const COMPILE_TIMEOUT_MS = 10_000

const getWorker = () => {
  if (!worker) {
    worker = new Worker(
      new URL('./worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (event: MessageEvent<{ id: string; code?: string; error?: string }>) => {
      const { id, code, error } = event.data
      const req = pending.get(id)
      if (!req) return
      pending.delete(id)
      clearTimeout(req.timer)
      if (error) {
        req.resolve({ error })
      } else {
        req.resolve({ code: code ?? '' })
      }
    }
  }
  return worker
}

export const compile = (source: string): Promise<CompileResult> => {
  return new Promise<CompileResult>((resolve) => {
    const id = String(++requestId)
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ error: 'Compilation timed out (10s).' })
    }, COMPILE_TIMEOUT_MS)

    pending.set(id, { resolve, timer })
    getWorker().postMessage({ id, source })
  })
}

export const disposeCompiler = () => {
  if (worker) {
    worker.terminate()
    worker = null
  }
  for (const [, req] of pending) {
    clearTimeout(req.timer)
    req.resolve({ error: 'Compiler disposed.' })
  }
  pending.clear()
}
