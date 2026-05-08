import path from 'path'
import { spawn } from 'child_process'

/**
 * Single source of truth for the directory and runtime contract used by
 * `payload.kind === 'script'` cron jobs and the `ScriptDraft` tool that
 * authors them. Keeping the dirname here means the Schedule subagent
 * never picks the path — `ScriptDraft` assigns it and the scheduler tick
 * reads it back without any string drift between the two paths.
 */
export const SCHEDULE_SCRIPTS_DIRNAME = 'schedule-scripts'

/** Resolve the absolute scripts directory under a Stella home. */
export const scheduleScriptsDir = (stellaHome: string): string =>
  path.join(stellaHome, 'state', SCHEDULE_SCRIPTS_DIRNAME)

/**
 * Wall-clock cap for both the `ScriptDraft` dry-run and every scheduled
 * fire. 30s is enough for an HTTP fetch + parse but tight enough that a
 * runaway script can't block the scheduler tick (which serializes work).
 */
export const SCRIPT_RUN_TIMEOUT_MS = 30_000

/**
 * Cap captured stdout/stderr to keep tool replies and `lastError` payloads
 * small. The script should print its message body, not log spew.
 */
export const SCRIPT_CAPTURE_BYTES = 16 * 1024

export type ScriptRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

const truncateOutput = (value: string): string => {
  if (value.length <= SCRIPT_CAPTURE_BYTES) {
    return value
  }
  const head = value.slice(0, SCRIPT_CAPTURE_BYTES)
  const dropped = value.length - SCRIPT_CAPTURE_BYTES
  return `${head}\n…[${dropped} bytes truncated]`
}

/**
 * Run a schedule script via `bun run` with the contract documented in
 * `LocalCronPayload['script']`. Centralizes timeout, capture limits, and
 * cwd so the dry-run from `ScriptDraft` and the scheduled fire produce
 * identical execution semantics.
 */
export const runScheduleScript = (
  scriptPath: string,
  options?: { signal?: AbortSignal },
): Promise<ScriptRunResult> =>
  new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('bun', ['run', scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        STELLA_SCHEDULE_SCRIPT_PATH: scriptPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (
      exitCode: number,
      tail: { kind: 'exit' | 'kill' | 'error' } & {
        message?: string
      },
    ) => {
      if (settled) return
      settled = true
      const durationMs = Date.now() - startedAt
      const result: ScriptRunResult = {
        exitCode,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(
          tail.kind === 'error' && tail.message
            ? `${stderr}\n[spawn error: ${tail.message}]`
            : stderr,
        ),
        durationMs,
        timedOut,
      }
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      if (stdout.length > SCRIPT_CAPTURE_BYTES * 2) {
        stdout = stdout.slice(0, SCRIPT_CAPTURE_BYTES * 2)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      if (stderr.length > SCRIPT_CAPTURE_BYTES * 2) {
        stderr = stderr.slice(0, SCRIPT_CAPTURE_BYTES * 2)
      }
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SCRIPT_RUN_TIMEOUT_MS)
    timer.unref?.()

    const onAbort = () => {
      child.kill('SIGKILL')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      finish(-1, { kind: 'error', message: error.message })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      const exitCode = typeof code === 'number' ? code : signal ? -1 : 0
      finish(exitCode, { kind: signal ? 'kill' : 'exit' })
    })
  })
