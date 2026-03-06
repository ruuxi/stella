import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { resolveNativeHelperPath } from '../native-helper-path.js'

type DuckSnapshotEntry = {
  sessionId: string
  sessionInstanceId: string
  volume: number
}

type AudioDuckingAction = 'duck' | 'restore'

type AudioDuckingRequest = {
  action: AudioDuckingAction
  excludePids: number[]
  excludeProcessPaths: string[]
  excludeProcessNames: string[]
  snapshot: DuckSnapshotEntry[]
  duckFactor: number
  recoverExcludedSessions: boolean
  recoveryThreshold: number
  recoveryFloor: number
}

const WINDOWS_DUCK_FACTOR = 0.25

const uniquePids = (values: Array<number | null | undefined>): number[] =>
  [...new Set(values.filter((value): value is number => Number.isInteger(value) && (value ?? 0) > 0))]

const encodeField = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
const decodeField = (value: string): string => Buffer.from(value, 'base64').toString('utf8')

const serializeRequest = (request: AudioDuckingRequest): string => {
  const lines = [
    `ACTION\t${request.action}`,
    `DUCK_FACTOR\t${request.duckFactor}`,
    `RECOVER_EXCLUDED_SESSIONS\t${request.recoverExcludedSessions ? '1' : '0'}`,
    `RECOVERY_THRESHOLD\t${request.recoveryThreshold}`,
    `RECOVERY_FLOOR\t${request.recoveryFloor}`,
  ]

  for (const pid of request.excludePids) {
    lines.push(`EXCLUDE_PID\t${pid}`)
  }
  for (const processPath of request.excludeProcessPaths) {
    lines.push(`EXCLUDE_PATH_B64\t${encodeField(processPath)}`)
  }
  for (const processName of request.excludeProcessNames) {
    lines.push(`EXCLUDE_NAME_B64\t${encodeField(processName)}`)
  }
  for (const entry of request.snapshot) {
    lines.push(
      `SNAPSHOT\t${encodeField(entry.sessionId)}\t${encodeField(entry.sessionInstanceId)}\t${entry.volume}`,
    )
  }

  return `${lines.join('\n')}\n`
}

const parseResponse = (stdout: string): DuckSnapshotEntry[] => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    throw new Error('Helper returned no response')
  }

  const [first, ...rest] = lines
  if (first === 'OK') {
    const snapshot: DuckSnapshotEntry[] = []
    for (const line of rest) {
      const parts = line.split('\t')
      if (parts[0] !== 'SNAPSHOT' || parts.length < 4) continue
      snapshot.push({
        sessionId: decodeField(parts[1]),
        sessionInstanceId: decodeField(parts[2]),
        volume: Number(parts[3]),
      })
    }
    return snapshot
  }

  if (first.startsWith('ERROR\t')) {
    throw new Error(first.slice('ERROR\t'.length))
  }

  throw new Error(`Unexpected helper response: ${first}`)
}

const runNativeAudioHelper = (request: AudioDuckingRequest): Promise<DuckSnapshotEntry[]> =>
  new Promise((resolve, reject) => {
    const helperPath = resolveNativeHelperPath('audio_ducking')
    if (!helperPath) {
      reject(new Error('audio_ducking helper not found'))
      return
    }

    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      callback()
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      settle(() => reject(error))
    })

    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          try {
            parseResponse(stdout)
          } catch (error) {
            reject(error)
            return
          }
          reject(new Error(stderr.trim() || `audio_ducking exited with code ${code}`))
          return
        }

        try {
          resolve(parseResponse(stdout))
        } catch (error) {
          reject(error)
        }
      })
    })

    child.stdin.end(serializeRequest(request), 'utf8')
  })

export class AudioDuckingService {
  private duckSnapshot: DuckSnapshotEntry[] = []
  private active = false
  private inFlight: Promise<void> | null = null
  private selfRecoveryAttempted = false

  constructor(
    private readonly getWindows: () => BrowserWindow[],
  ) {}

  async setAssistantSpeaking(active: boolean): Promise<void> {
    if (this.inFlight) {
      await this.inFlight.catch(() => {})
    }
    this.inFlight = active ? this.activate() : this.deactivate()
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private isNativeAudioHelperSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin'
  }

  private async activate(): Promise<void> {
    if (this.active) return
    this.active = true

    if (!this.isNativeAudioHelperSupported()) {
      return
    }

    try {
      const shouldRecoverSelfSessions = !this.selfRecoveryAttempted
      this.selfRecoveryAttempted = true
      this.duckSnapshot = await runNativeAudioHelper({
        action: 'duck',
        excludePids: this.getExcludedProcessIds(),
        excludeProcessPaths: this.getExcludedProcessPaths(),
        excludeProcessNames: this.getExcludedProcessNames(),
        recoverExcludedSessions: shouldRecoverSelfSessions,
        recoveryThreshold: WINDOWS_DUCK_FACTOR + 0.01,
        recoveryFloor: 1.0,
        snapshot: [],
        duckFactor: WINDOWS_DUCK_FACTOR,
      })
    } catch (error) {
      this.active = false
      this.duckSnapshot = []
      console.debug('[audio-ducking] Failed to duck external audio:', (error as Error).message)
    }
  }

  private async deactivate(): Promise<void> {
    if (!this.active && this.duckSnapshot.length === 0) return
    this.active = false

    if (!this.isNativeAudioHelperSupported()) {
      return
    }
    if (this.duckSnapshot.length === 0) {
      return
    }

    const snapshot = this.duckSnapshot
    this.duckSnapshot = []

    try {
      await runNativeAudioHelper({
        action: 'restore',
        excludePids: [],
        excludeProcessPaths: [],
        excludeProcessNames: [],
        recoverExcludedSessions: false,
        recoveryThreshold: 0,
        recoveryFloor: 1.0,
        snapshot,
        duckFactor: WINDOWS_DUCK_FACTOR,
      })
    } catch (error) {
      console.debug('[audio-ducking] Failed to restore external audio:', (error as Error).message)
    }
  }

  private getExcludedProcessIds(): number[] {
    return uniquePids([
      process.pid,
      ...app.getAppMetrics().map((metric) => metric.pid),
      ...this.getWindows().flatMap((window) => {
        if (window.isDestroyed()) return []
        return [window.webContents.getOSProcessId()]
      }),
    ])
  }

  private getExcludedProcessPaths(): string[] {
    return [process.execPath]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  }

  private getExcludedProcessNames(): string[] {
    const executableWithExtension = path.basename(process.execPath).trim().toLowerCase()
    const executableWithoutExtension = path.basename(process.execPath, path.extname(process.execPath)).trim().toLowerCase()

    return [...new Set([executableWithExtension, executableWithoutExtension].filter((value) => value.length > 0))]
  }
}
