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

let shuttingDown = false
let currentApp = null
let restartTimer = null
let watcher = null
let restartQueue = Promise.resolve()
const expectedExits = new WeakSet()

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

  const child = spawn(electronBinary, ['.'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
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

const shutdown = async (exitCode) => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  watcher?.close()
  await stopApp()
  process.exit(exitCode)
}

await waitOn({
  resources: requiredFiles.map((filePath) => `file:${filePath}`),
})

watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!shouldRestartForPath(filename)) {
    return
  }

  scheduleRestart()
})

startApp()

process.once('SIGINT', () => {
  void shutdown(130)
})

process.once('SIGTERM', () => {
  void shutdown(143)
})
