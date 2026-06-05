import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolveNativeHelperPath } from './native-helper-path.js'
import { getFileLogger } from '../../runtime/observability/file-logger.js'

// stdio: ['pipe', 'pipe', 'ignore'] → writable stdin, readable stdout, no stderr.
type DaemonChild = ChildProcessByStdio<Writable, Readable, null>

/**
 * Persistent `window_info --serve` client (Windows only).
 *
 * Each one-shot `window_info` invocation is a full `CreateProcess`, which on
 * Windows is scanned by Defender and shows up as system-wide lag when the hot
 * paths (capture window-highlight hover, morph-visibility sample grid) probe
 * many points in quick succession. The daemon keeps a single helper process
 * alive and answers point/batch queries over stdin/stdout, so those probes
 * cost a pipe write instead of a process spawn.
 *
 * Protocol (line-delimited, see `window_info.cpp` `--serve`):
 *   request:  `<id>\t<token>\t<token>...\n`   (tokens mirror the one-shot CLI)
 *   response: `<id>\t<json>\n`
 *
 * `request()` returns the raw JSON response string (caller parses it the same
 * way it parses one-shot stdout), or `undefined` when the daemon is
 * unavailable / errored / timed out — callers treat `undefined` as "fall back
 * to a one-shot spawn" so behavior degrades gracefully if the helper is
 * missing, old (no `--serve`), or wedged.
 */

const HELPER_NAME = 'window_info'
const REQUEST_TIMEOUT_MS = 2_000
// After this many consecutive failures (timeouts / write errors) stop using the
// daemon for a cooldown and let callers spawn one-shot helpers, so a broken
// daemon can't wedge the hot path indefinitely.
const MAX_CONSECUTIVE_FAILURES = 3
const DISABLE_COOLDOWN_MS = 60_000
// An older `window_info.exe` (no `--serve`) treats `--serve` as junk argv,
// prints usage, and exits immediately. If a freshly-spawned daemon dies this
// fast without ever answering, assume it's unsupported and stop probing it for
// a long while (binaries don't change mid-session) so we don't double-spawn
// (failed daemon + one-shot fallback) on every call.
const EARLY_EXIT_MS = 1_000
const UNSUPPORTED_COOLDOWN_MS = 30 * 60_000
// Bound the in-flight set so a stalled daemon can't grow memory without bound;
// excess callers fall back to one-shot spawns until it drains.
const MAX_PENDING = 64

type PendingRequest = {
  resolve: (value: string | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

class WindowInfoDaemon {
  private child: DaemonChild | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private stdoutBuf = ''
  private consecutiveFailures = 0
  private disabledUntil = 0
  private childSpawnedAt = 0
  private childAnswered = false

  private ensureChild(): DaemonChild | null {
    if (this.child) return this.child
    if (Date.now() < this.disabledUntil) return null

    const helperPath = resolveNativeHelperPath(HELPER_NAME)
    if (!helperPath) return null

    let child: DaemonChild
    try {
      child = spawn(helperPath, ['--serve'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      this.noteFailure()
      return null
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    // EPIPE etc. land here once the child is gone; swallow so a dead daemon
    // can't crash the main process.
    child.stdin.on('error', () => {})
    child.on('exit', () => this.onChildGone())
    child.on('error', () => this.onChildGone())

    this.child = child
    this.childSpawnedAt = Date.now()
    this.childAnswered = false
    getFileLogger()?.process('native.helper.daemon.started', {
      helper: HELPER_NAME,
    })
    return child
  }

  private onChildGone() {
    const spawnedAt = this.childSpawnedAt
    const answered = this.childAnswered
    this.child = null
    this.stdoutBuf = ''
    this.childSpawnedAt = 0
    this.childAnswered = false
    // Any in-flight requests can no longer be answered — resolve them as
    // "unavailable" so callers fall back rather than hang.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(undefined)
    }
    this.pending.clear()
    // Died immediately without ever answering → almost certainly an old binary
    // that doesn't understand `--serve`. Stop probing it for the session.
    if (!answered && spawnedAt > 0 && Date.now() - spawnedAt < EARLY_EXIT_MS) {
      this.disabledUntil = Date.now() + UNSUPPORTED_COOLDOWN_MS
      getFileLogger()?.process('native.helper.daemon.unsupported', {
        helper: HELPER_NAME,
        cooldownMs: UNSUPPORTED_COOLDOWN_MS,
      })
    }
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk
    let newlineIdx = this.stdoutBuf.indexOf('\n')
    while (newlineIdx >= 0) {
      const line = this.stdoutBuf.slice(0, newlineIdx)
      this.stdoutBuf = this.stdoutBuf.slice(newlineIdx + 1)
      this.handleLine(line)
      newlineIdx = this.stdoutBuf.indexOf('\n')
    }
  }

  private handleLine(rawLine: string) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const tab = line.indexOf('\t')
    if (tab < 0) return
    const id = Number(line.slice(0, tab))
    if (!Number.isFinite(id)) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.consecutiveFailures = 0
    this.childAnswered = true
    pending.resolve(line.slice(tab + 1))
  }

  private noteFailure() {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.disabledUntil = Date.now() + DISABLE_COOLDOWN_MS
      this.consecutiveFailures = 0
      getFileLogger()?.warn('native.helper.daemon.disabled', {
        helper: HELPER_NAME,
        cooldownMs: DISABLE_COOLDOWN_MS,
      })
      this.kill()
    }
  }

  private kill() {
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.onChildGone()
  }

  request(tokens: string[]): Promise<string | undefined> {
    // Both platforms pay a real per-spawn cost — Windows via CreateProcess +
    // Defender (system-wide lag), macOS via Swift/dyld/framework load (~40ms).
    // Other platforms keep the one-shot path.
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return Promise.resolve(undefined)
    }
    if (this.pending.size >= MAX_PENDING) return Promise.resolve(undefined)

    const child = this.ensureChild()
    if (!child || !child.stdin.writable) return Promise.resolve(undefined)

    const id = this.nextId++
    const payload = `${id}\t${tokens.join('\t')}\n`

    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        // A timed-out daemon may be wedged (e.g. a hung target window's
        // WM_GETTEXT). Recycle it so the next call gets a fresh process, and
        // count it toward the disable threshold.
        this.noteFailure()
        this.kill()
        resolve(undefined)
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, timer })

      try {
        child.stdin.write(payload)
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        this.noteFailure()
        resolve(undefined)
      }
    })
  }

  stop() {
    this.disabledUntil = 0
    this.consecutiveFailures = 0
    this.kill()
  }
}

const windowInfoDaemon = new WindowInfoDaemon()

/**
 * Ask the persistent `window_info` daemon for the JSON response to a set of
 * CLI-style tokens. Returns the raw response string, or `undefined` when the
 * daemon is unavailable and the caller should fall back to a one-shot spawn.
 */
export const requestWindowInfoDaemon = (
  tokens: string[],
): Promise<string | undefined> => windowInfoDaemon.request(tokens)

/** Tear down the daemon process (wired into app shutdown). */
export const stopWindowInfoDaemon = (): void => windowInfoDaemon.stop()
