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

type HelperCircuit = { consecutiveFailures: number; openUntil: number }
const circuits = new Map<string, HelperCircuit>()

// Global Win32 spawn governor. Every helper invocation is a full
// `CreateProcess`, which on Windows is scanned by Defender and shows up as
// system-wide (not just Stella) lag when several callers fire at once (capture
// probes, the morph-visibility sample grid, context polls). Serialize win32
// spawns so concurrent callers queue behind a single in-flight process instead
// of stampeding the OS process-creation path. macOS `fork` is cheap, so this
// only gates win32.
const WIN32_MAX_CONCURRENT_SPAWNS = 1
let win32ActiveSpawns = 0
const win32SpawnWaiters: Array<() => void> = []

const acquireWin32SpawnSlot = (): Promise<void> => {
  if (win32ActiveSpawns < WIN32_MAX_CONCURRENT_SPAWNS) {
    win32ActiveSpawns += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    win32SpawnWaiters.push(() => {
      win32ActiveSpawns += 1
      resolve()
    })
  })
}

const releaseWin32SpawnSlot = () => {
  win32ActiveSpawns = Math.max(0, win32ActiveSpawns - 1)
  const next = win32SpawnWaiters.shift()
  if (next) next()
}

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

const circuitOpenResult = (circuit: HelperCircuit): NativeHelperRunResult => {
  const now = Date.now()
  return {
    stdout: null,
    skipped: true,
    skippedReason: 'circuit-open',
    error: null,
    killed: false,
    timedOut: false,
    durationMs: 0,
    circuitOpenMs: circuit.openUntil > now ? circuit.openUntil - now : 0,
  }
}

export const runNativeHelperDetailed = async (
  helperName: string,
  args: string[],
  options: RunNativeHelperOptions,
): Promise<NativeHelperRunResult> => {
  const helperPath = resolveNativeHelperPath(helperName)
  if (!helperPath) {
    return {
      stdout: null,
      skipped: true,
      skippedReason: 'missing',
      error: null,
      killed: false,
      timedOut: false,
      durationMs: 0,
      circuitOpenMs: 0,
    }
  }

  const circuit = getCircuit(helperName)
  if (circuit.openUntil > Date.now()) {
    // Circuit open — skip the spawn entirely until the cooldown elapses.
    return circuitOpenResult(circuit)
  }
  const useGovernor = process.platform === 'win32'
  if (useGovernor) {
    await acquireWin32SpawnSlot()
  }
  // The circuit may have opened while we waited for a spawn slot; re-check so a
  // freshly-broken helper doesn't get spawned anyway after queueing.
  if (circuit.openUntil > Date.now()) {
    if (useGovernor) releaseWin32SpawnSlot()
    return circuitOpenResult(circuit)
  }

  try {
    return await new Promise<NativeHelperRunResult>((resolve) => {
    const startedAt = Date.now()
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
  } finally {
    if (useGovernor) releaseWin32SpawnSlot()
  }
}

export const runNativeHelper = async (
  helperName: string,
  args: string[],
  options: RunNativeHelperOptions,
): Promise<string | null> =>
  (await runNativeHelperDetailed(helperName, args, options)).stdout
