import { execFile } from 'child_process'
import { resolveNativeHelperPath } from './native-helper-path.js'
import { getFileLogger } from '../../runtime/observability/file-logger.js'

type RunNativeHelperOptions = {
  timeout: number
  encoding?: BufferEncoding
  maxBuffer?: number
  onError?: (error: Error) => void
}

export type NativeHelperRunResult = {
  stdout: string | null
  skipped: boolean
  skippedReason: 'missing' | 'circuit-open' | 'in-flight' | null
  error: Error | null
  killed: boolean
  timedOut: boolean
  durationMs: number
  circuitOpenMs: number
}

// Some helpers (e.g. window_info) run on cursor-move loops. We only log on
// failure, but a consistently-failing helper could still flap fast — throttle
// to one log per helper per window so a broken helper can't spam the file.
const FAILURE_LOG_THROTTLE_MS = 30_000
const SLOW_HELPER_LOG_THRESHOLD_MS = 500
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
const WIN32_SLOW_SUCCESS_COOLDOWN_MS = 60_000
const WIN32_SLOW_SUCCESS_THRESHOLD_MS = 1_000
const WIN32_HIGH_RISK_HELPERS = new Set([
  'recent_apps',
  'selected_text',
  'window_info',
])

type HelperCircuit = { consecutiveFailures: number; openUntil: number }
const circuits = new Map<string, HelperCircuit>()
const inFlightWin32Helpers = new Set<string>()

const getCircuit = (helperName: string): HelperCircuit => {
  let circuit = circuits.get(helperName)
  if (!circuit) {
    circuit = { consecutiveFailures: 0, openUntil: 0 }
    circuits.set(helperName, circuit)
  }
  return circuit
}

const openCircuit = (circuit: HelperCircuit, now: number) => {
  circuit.openUntil = Math.max(circuit.openUntil, now + CIRCUIT_COOLDOWN_MS)
}

const helperTimedOutOrKilled = (error: Error): boolean => {
  const typed = error as NodeJS.ErrnoException & {
    killed?: boolean
    signal?: string | null
  }
  return (
    typed.killed === true ||
    typed.code === 'ETIMEDOUT' ||
    typed.signal === 'SIGTERM'
  )
}

export const runNativeHelperDetailed = (
  helperName: string,
  args: string[],
  options: RunNativeHelperOptions,
): Promise<NativeHelperRunResult> => {
  const helperPath = resolveNativeHelperPath(helperName)
  if (!helperPath) {
    return Promise.resolve({
      stdout: null,
      skipped: true,
      skippedReason: 'missing',
      error: null,
      killed: false,
      timedOut: false,
      durationMs: 0,
      circuitOpenMs: 0,
    })
  }

  const circuit = getCircuit(helperName)
  const beforeSpawn = Date.now()
  if (circuit.openUntil > beforeSpawn) {
    // Circuit open — skip the spawn entirely until the cooldown elapses.
    return Promise.resolve({
      stdout: null,
      skipped: true,
      skippedReason: 'circuit-open',
      error: null,
      killed: false,
      timedOut: false,
      durationMs: 0,
      circuitOpenMs: circuit.openUntil - beforeSpawn,
    })
  }
  const shouldBackpressure =
    process.platform === 'win32' && WIN32_HIGH_RISK_HELPERS.has(helperName)
  if (shouldBackpressure && inFlightWin32Helpers.has(helperName)) {
    return Promise.resolve({
      stdout: null,
      skipped: true,
      skippedReason: 'in-flight',
      error: null,
      killed: false,
      timedOut: false,
      durationMs: 0,
      circuitOpenMs: 0,
    })
  }

  return new Promise((resolve) => {
    const startedAt = Date.now()
    if (shouldBackpressure) {
      inFlightWin32Helpers.add(helperName)
    }
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
        const now = Date.now()
        const durationMs = now - startedAt
        if (shouldBackpressure) {
          inFlightWin32Helpers.delete(helperName)
        }
        if (error) {
          const typedError = error as NodeJS.ErrnoException & {
            killed?: boolean
          }
          const killed = typedError.killed === true
          const timedOut = helperTimedOutOrKilled(error)
          circuit.consecutiveFailures += 1
          if (process.platform === 'win32' && timedOut) {
            openCircuit(circuit, now)
          } else if (
            circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
            circuit.openUntil <= now
          ) {
            openCircuit(circuit, now)
          }
          const last = lastFailureLogAt.get(helperName) ?? 0
          if (now - last >= FAILURE_LOG_THROTTLE_MS) {
            lastFailureLogAt.set(helperName, now)
            getFileLogger()?.warn('native.helper.failed', {
              helper: helperName,
              durationMs,
              timeoutMs: options.timeout,
              code: typedError.code,
              killed,
              timedOut,
              consecutiveFailures: circuit.consecutiveFailures,
              circuitOpenMs:
                circuit.openUntil > now ? circuit.openUntil - now : 0,
              error,
            })
          }
          options.onError?.(error)
          resolve({
            stdout: null,
            skipped: false,
            skippedReason: null,
            error,
            killed,
            timedOut,
            durationMs,
            circuitOpenMs:
              circuit.openUntil > now ? circuit.openUntil - now : 0,
          })
          return
        }
        circuit.consecutiveFailures = 0
        circuit.openUntil = 0
        if (
          shouldBackpressure &&
          durationMs >= WIN32_SLOW_SUCCESS_THRESHOLD_MS
        ) {
          circuit.openUntil = Math.max(
            circuit.openUntil,
            now + WIN32_SLOW_SUCCESS_COOLDOWN_MS,
          )
        }
        if (durationMs >= SLOW_HELPER_LOG_THRESHOLD_MS) {
          getFileLogger()?.process('native.helper.slow', {
            helper: helperName,
            durationMs,
            timeoutMs: options.timeout,
          })
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout.trim() || null : null,
          skipped: false,
          skippedReason: null,
          error: null,
          killed: false,
          timedOut: false,
          durationMs,
          circuitOpenMs:
            circuit.openUntil > now ? circuit.openUntil - now : 0,
        })
      },
    )
  })
}

export const runNativeHelper = async (
  helperName: string,
  args: string[],
  options: RunNativeHelperOptions,
): Promise<string | null> =>
  (await runNativeHelperDetailed(helperName, args, options)).stdout
