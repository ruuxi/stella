import { spawn, execSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, watch } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import waitOn from 'wait-on'
import { shouldRestartElectronForBuildPath } from './dev-electron-restart-filter.mjs'

const require = createRequire(import.meta.url)
const projectDir = process.cwd()
let electronBinary = require('electron')

const patchDevIcon = () => {
  const appIcon = path.join(projectDir, 'build', 'icon.icns')
  const appBundle = path.join(path.dirname(electronBinary), '..')
  const electronIcon = path.join(appBundle, 'Resources', 'electron.icns')
  const infoPlist = path.join(appBundle, 'Info.plist')
  if (!existsSync(appIcon) || !existsSync(electronIcon)) {
    return
  }

  const srcHash = createHash('md5').update(readFileSync(appIcon)).digest('hex')
  const dstHash = createHash('md5').update(readFileSync(electronIcon)).digest('hex')
  if (srcHash === dstHash) {
    return
  }

  try {
    copyFileSync(appIcon, electronIcon)
    if (existsSync(infoPlist)) {
      execSync(`touch "${path.join(appBundle, '..')}"`, { stdio: 'ignore' })
    }
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
}

const patchDevAppName = () => {
  const distDir = path.resolve(path.dirname(electronBinary), '..', '..', '..')
  const oldBundle = path.join(distDir, 'Electron.app')
  const newBundle = path.join(distDir, 'Stella.app')
  const pathTxtFile = path.resolve(distDir, '..', 'path.txt')

  if (!existsSync(oldBundle)) {
    return
  }

  try {
    renameSync(oldBundle, newBundle)
    electronBinary = electronBinary.replace('Electron.app', 'Stella.app')

    if (existsSync(pathTxtFile)) {
      const pathTxt = readFileSync(pathTxtFile, 'utf8')
      writeFileSync(pathTxtFile, pathTxt.replace('Electron.app', 'Stella.app'))
    }

    const infoPlist = path.join(newBundle, 'Contents', 'Info.plist')
    if (existsSync(infoPlist)) {
      let plist = readFileSync(infoPlist, 'utf8')
      let changed = false

      const replaceName = (key) => {
        const pattern = new RegExp(
          `(<key>${key}</key>\\s*<string>)([^<]+)(<\\/string>)`,
        )
        const match = plist.match(pattern)
        if (match && match[2] !== 'Stella') {
          plist = plist.replace(pattern, `$1Stella$3`)
          changed = true
        }
      }

      replaceName('CFBundleName')
      replaceName('CFBundleDisplayName')

      if (changed) {
        writeFileSync(infoPlist, plist)
      }
    }

    execSync(`touch "${distDir}"`, { stdio: 'ignore' })
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
}

if (process.platform === 'darwin') {
  patchDevIcon()
  patchDevAppName()
}
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
let restartRequestedByWatcher = false
const expectedExits = new WeakSet()

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

    if (!shuttingDown && restartRequestedByWatcher) {
      scheduleRestart()
    }
  })

  child.once('exit', (code, signal) => {
    if (currentApp === child) {
      currentApp = null
    }

    if (shuttingDown || expectedExits.has(child)) {
      return
    }

    if (restartRequestedByWatcher) {
      scheduleRestart()
      return
    }

    exitCode = code ?? 1
    logError(
      `electron-main exited ${signal ? `via ${signal}` : `with code ${code ?? 0}`} without a watched build change; stopping electron dev.`,
    )
    void shutdown(exitCode)
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
          restartRequestedByWatcher = false
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

  restartRequestedByWatcher = true
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
