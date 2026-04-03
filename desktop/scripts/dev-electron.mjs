import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import waitOn from 'wait-on'
import { shouldRestartElectronForBuildPath } from './dev-electron-restart-filter.mjs'

const require = createRequire(import.meta.url)
const projectDir = process.cwd()
const electronBinary = require('electron')
const watchedDir = path.join(projectDir, 'dist-electron')
const requiredFiles = [
  path.join(projectDir, '.vite-dev-url'),
  path.join(watchedDir, 'electron', 'main.js'),
  path.join(watchedDir, 'electron', 'preload.js'),
]
const restartDebounceMs = 150
const forcedShutdownTimeoutMs = 1_500
const startupWatchDelayMs = 2_500
const maxRapidCrashes = 5
const rapidCrashWindowMs = 10_000

let shuttingDown = false
let currentApp = null
let restartTimer = null
let watcher = null
let restartQueue = Promise.resolve()
let watchReady = false
let watchReadyTimer = null
const expectedExits = new WeakSet()
const crashTimestamps = []

const startApp = () => {
  if (shuttingDown || currentApp) {
    return
  }

  const child = spawn(electronBinary, ['.'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
    windowsHide: true,
  })

  currentApp = child

  child.once('error', () => {
    if (currentApp === child) {
      currentApp = null
    }

    if (!shuttingDown) {
      scheduleRestart()
    }
  })

  child.once('exit', () => {
    if (currentApp === child) {
      currentApp = null
    }

    if (!shuttingDown && !expectedExits.has(child)) {
      scheduleRestart()
    }
  })
}

const stopApp = async () => {
  const child = currentApp
  if (!child) {
    return
  }

  currentApp = null
  expectedExits.add(child)

  await new Promise((resolve) => {
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true
      resolve()
    }

    child.once('exit', finish)
    child.kill('SIGTERM')

    setTimeout(() => {
      if (settled) {
        return
      }

      child.kill('SIGKILL')
      finish()
    }, forcedShutdownTimeoutMs).unref()
  })
}

const isRapidCrashLoop = () => {
  const now = Date.now()
  crashTimestamps.push(now)
  while (crashTimestamps.length > 0 && now - crashTimestamps[0] > rapidCrashWindowMs) {
    crashTimestamps.shift()
  }
  return crashTimestamps.length >= maxRapidCrashes
}

const scheduleRestart = () => {
  if (shuttingDown) {
    return
  }

  if (isRapidCrashLoop()) {
    logError(`Electron crashed ${maxRapidCrashes} times within ${rapidCrashWindowMs / 1000}s — stopping. Check permissions or logs, then re-run.`)
    void shutdown(1)
    return
  }

  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  restartTimer = setTimeout(() => {
    restartTimer = null
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp()
        if (!shuttingDown) {
          startApp()
        }
      })
  }, restartDebounceMs)
}

const scheduleWatchReady = () => {
  if (watchReadyTimer) {
    clearTimeout(watchReadyTimer)
  }

  watchReadyTimer = setTimeout(() => {
    watchReady = true
    watchReadyTimer = null
  }, startupWatchDelayMs)
}

const shutdown = async (exitCode) => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  if (watchReadyTimer) {
    clearTimeout(watchReadyTimer)
    watchReadyTimer = null
  }

  watcher?.close()
  await stopApp()
  process.exit(exitCode)
}

await waitOn({
  resources: requiredFiles.map((filePath) => `file:${filePath}`),
})

watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!shouldRestartElectronForBuildPath(filename)) {
    return
  }

  if (!watchReady) {
    scheduleWatchReady()
    return
  }

  scheduleRestart()
})

startApp()
scheduleWatchReady()

process.once('SIGINT', () => {
  void shutdown(130)
})

process.once('SIGTERM', () => {
  void shutdown(143)
})
