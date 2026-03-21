import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import waitOn from 'wait-on'

const require = createRequire(import.meta.url)
const projectDir = process.cwd()
const electronBinary = require('electron')
const watchedDir = path.join(projectDir, 'dist-electron', 'electron')
const requiredFiles = [
  path.join(projectDir, '.vite-dev-url'),
  path.join(watchedDir, 'main.js'),
  path.join(watchedDir, 'preload.js'),
]
const restartDebounceMs = 150
const forcedShutdownTimeoutMs = 1_500
const startupWatchDelayMs = 2_500

let shuttingDown = false
let currentApp = null
let restartTimer = null
let watcher = null
let restartQueue = Promise.resolve()
let watchReady = false
let watchReadyTimer = null
const expectedExits = new WeakSet()
const startupProfilingEnabled = process.env.STELLA_STARTUP_PROFILING === '1'
const startupTraceId = process.env.STELLA_STARTUP_TRACE_ID ?? null

const emitStartupMetric = (metric, detail = {}) => {
  if (!startupProfilingEnabled) {
    return
  }

  console.log(
    `[stella-startup] ${JSON.stringify({
      atMs: Date.now(),
      detail,
      metric,
      pid: process.pid,
      source: 'dev-launcher',
      traceId: startupTraceId,
    })}`,
  )
}

const shouldRestartForPath = (filename) => {
  if (typeof filename !== 'string') {
    return false
  }

  return filename.endsWith('.js') && !filename.endsWith('.d.ts')
}

const startApp = () => {
  if (shuttingDown || currentApp) {
    return
  }

  emitStartupMetric('electron-spawn-requested')

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

const scheduleRestart = () => {
  if (shuttingDown) {
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

emitStartupMetric('dev-electron-launcher-ready', {
  watchedDir,
})

watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!shouldRestartForPath(filename)) {
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
