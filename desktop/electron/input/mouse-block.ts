/**
 * Spawns the platform-native `mouse_block` helper that intercepts and drops
 * Cmd/Ctrl + RightClick at the OS level so the foreground app's context menu
 * never appears.
 *
 *   macOS  → Swift CGEventTap (mouse_block)
 *   win32  → C++ WH_MOUSE_LL hook  (mouse_block.exe)
 *   linux  → not supported (pure-uIOhook fallback in MouseHookManager)
 *
 * Communication is line-based stdout: `READY`, `DOWN <x> <y>`, `UP <x> <y>`,
 * `EXIT`. Coordinates are native screen pixels.
 */

import { spawn, type ChildProcess } from 'child_process'
import { resolveNativeHelperPath } from '../native-helper-path.js'

export type MouseBlockEvent = 'down' | 'up'
export type MouseBlockCallback = (event: MouseBlockEvent, x: number, y: number) => void

let helperProcess: ChildProcess | null = null
let currentCallback: MouseBlockCallback | null = null
let isReady = false

const findHelperPath = (): string | null => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return null
  }
  return resolveNativeHelperPath('mouse_block')
}

/** True if a native mouse_block helper exists for the current platform. */
export const isNativeBlockingAvailable = (): boolean => {
  return findHelperPath() !== null
}

/**
 * Start the mouse blocking helper. Returns true if the helper was spawned.
 * The first `READY` line on stdout flips the manager into a ready state.
 */
export const startMouseBlock = (callback: MouseBlockCallback): boolean => {
  if (helperProcess) {
    return isReady
  }

  const helperPath = findHelperPath()
  if (!helperPath) {
    return false
  }

  currentCallback = callback

  try {
    helperProcess = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    helperProcess.stdout?.setEncoding('utf8')
    helperProcess.stderr?.setEncoding('utf8')

    helperProcess.stdout?.on('data', (data: string) => {
      const lines = data.split('\n')
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        const parts = line.split(/\s+/)
        const cmd = parts[0]

        if (cmd === 'READY') {
          isReady = true
        } else if (cmd === 'DOWN' && parts.length >= 3) {
          const x = parseInt(parts[1] ?? '', 10)
          const y = parseInt(parts[2] ?? '', 10)
          if (Number.isFinite(x) && Number.isFinite(y)) {
            currentCallback?.('down', x, y)
          }
        } else if (cmd === 'UP' && parts.length >= 3) {
          const x = parseInt(parts[1] ?? '', 10)
          const y = parseInt(parts[2] ?? '', 10)
          if (Number.isFinite(x) && Number.isFinite(y)) {
            currentCallback?.('up', x, y)
          }
        } else if (cmd === 'EXIT') {
          // Helper announced clean exit; the 'exit' handler will null out
          // helperProcess.
        }
      }
    })

    helperProcess.stderr?.on('data', (data: string) => {
      // Surface helper errors so missing-permission failures are diagnosable
      // in the dev console without spamming users.
      if (process.env.STELLA_DEBUG_MOUSE_BLOCK) {
        console.warn('[mouse-block] stderr:', data.trim())
      }
    })

    helperProcess.on('exit', () => {
      helperProcess = null
      isReady = false
    })

    helperProcess.on('error', (error) => {
      console.warn('[mouse-block] helper failed to start:', error.message)
      helperProcess = null
      isReady = false
    })

    return true
  } catch (error) {
    console.warn('[mouse-block] spawn threw:', (error as Error).message)
    helperProcess = null
    isReady = false
    return false
  }
}

/** Terminate the helper process. */
export const stopMouseBlock = (): boolean => {
  if (!helperProcess) {
    return true
  }
  try {
    helperProcess.kill('SIGTERM')
    helperProcess = null
    isReady = false
    currentCallback = null
    return true
  } catch {
    return false
  }
}
