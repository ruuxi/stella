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

// Circuit breaker. A helper that's simply broken on this machine (e.g. a
// crashing/hanging win32 `.exe`) must not be re-spawned on every cursor-move
// / context refresh — each failed spawn costs a full process launch plus the
// kill-timeout wait, which on Windows shows up as continuous system-wide lag.
// After N consecutive failures we stop spawning the helper for a cooldown,
// then allow a single probe; success closes the circuit, another failure
// re-opens it. This caps a broken helper to ~one spawn per cooldown instead
// of one per call.
const CIRCUIT_FAILURE_THRESHOLD = 3
const CIRCUIT_COOLDOWN_MS = 60_000

type HelperCircuit = { consecutiveFailures: number; openUntil: number }
const circuits = new Map<string, HelperCircuit>()

const getCircuit = (helperName: string): HelperCircuit => {
  let circuit = circuits.get(helperName)
  if (!circuit) {
    circuit = { consecutiveFailures: 0, openUntil: 0 }
    circuits.set(helperName, circuit)
  }
  return circuit
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

  const circuit = getCircuit(helperName)
  if (circuit.openUntil > Date.now()) {
    // Circuit open — skip the spawn entirely until the cooldown elapses.
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
          circuit.consecutiveFailures += 1
          if (
            circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
            circuit.openUntil <= Date.now()
          ) {
            circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS
          }
          const now = Date.now()
          const last = lastFailureLogAt.get(helperName) ?? 0
          if (now - last >= FAILURE_LOG_THROTTLE_MS) {
            lastFailureLogAt.set(helperName, now)
            getFileLogger()?.warn('native.helper.failed', {
              helper: helperName,
              code: (error as NodeJS.ErrnoException).code,
              killed: (error as { killed?: boolean }).killed,
              consecutiveFailures: circuit.consecutiveFailures,
              circuitOpenMs:
                circuit.openUntil > now ? circuit.openUntil - now : 0,
              error,
            })
          }
          options.onError?.(error)
          resolve(null)
          return
        }
        circuit.consecutiveFailures = 0
        circuit.openUntil = 0
        resolve(typeof stdout === 'string' ? stdout.trim() || null : null)
      },
    )
  })
}
