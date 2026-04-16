import { execFileSync, execSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  watch,
  statSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import waitOn from 'wait-on'
import { shouldRestartElectronForBuildPath } from './dev-electron-restart-filter.mjs'

const require = createRequire(import.meta.url)
const DEV_MACOS_APP_NAME = 'Stella'
const DEV_MACOS_BUNDLE_ID = 'com.stella.app'
const DEV_MACOS_RUNTIME_DIR_NAME = '.stella-dev-runtime'
const projectDir = process.cwd()
let electronBinary = require('electron')
const watchedDir = path.join(projectDir, 'dist-electron')
const runtimeReloadStateFile = path.join(projectDir, '.stella-runtime-reload-state.json')
const devRuntimeRoot = path.join(projectDir, DEV_MACOS_RUNTIME_DIR_NAME)
const legacyRuntimeElectronBinary = path.join(
  devRuntimeRoot,
  'Stella.app',
  'Contents',
  'MacOS',
  'Electron',
)
const requiredFiles = [
  path.join(projectDir, '.vite-dev-url'),
  path.join(watchedDir, 'desktop', 'electron', 'main.js'),
  path.join(watchedDir, 'desktop', 'electron', 'preload.js'),
]
const restartDebounceMs = 150
const forcedShutdownTimeoutMs = 1_500
const startupWatchDelayMs = 2_500
const staleAppShutdownPollMs = 150
const staleAppShutdownTimeoutMs = 3_000

let shuttingDown = false
let currentApp = null
let restartTimer = null
let watcher = null
let restartQueue = Promise.resolve()
let watchReady = false
let watchReadyTimer = null
let restartRequestedByWatcher = false
let exitCode = 0
let rootWatcher = null
let pendingRestartWhilePaused = false
const expectedExits = new WeakSet()

const readHash = (filePath) => {
  if (!existsSync(filePath)) {
    return null
  }
  return createHash('md5').update(readFileSync(filePath)).digest('hex')
}

/**
 * Packaged apps get NSMicrophoneUsageDescription from electron-builder extendInfo.
 * The stock Electron.app in node_modules does not, so macOS never shows the mic
 * prompt for getUserMedia in dev — inject the same string we ship in production.
 */
const MIC_USAGE_DESCRIPTION =
  'Stella uses your microphone for voice conversations.'

const patchDevIcon = () => {
  const appIcon = path.join(projectDir, 'build', 'icon.icns')
  const appBundle = path.join(path.dirname(electronBinary), '..')
  const electronIcon = path.join(appBundle, 'Resources', 'electron.icns')
  const infoPlist = path.join(appBundle, 'Info.plist')
  if (!existsSync(appIcon) || !existsSync(electronIcon)) {
    return
  }

  const srcHash = readHash(appIcon)
  const dstHash = readHash(electronIcon)
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
  const hasOldBundle = existsSync(oldBundle)
  const hasNewBundle = existsSync(newBundle)

  if (!hasOldBundle && !hasNewBundle) {
    return
  }

  try {
    if (hasOldBundle && !hasNewBundle) {
      renameSync(oldBundle, newBundle)
    }
    electronBinary = electronBinary.replace('Electron.app', 'Stella.app')

    if (existsSync(pathTxtFile)) {
      const pathTxt = readFileSync(pathTxtFile, 'utf8')
      const nextPathTxt = pathTxt.replace('Electron.app', 'Stella.app')
      if (nextPathTxt !== pathTxt) {
        writeFileSync(pathTxtFile, nextPathTxt)
      }
    }

    const infoPlist = path.join(newBundle, 'Contents', 'Info.plist')
    if (existsSync(infoPlist)) {
      let plist = readFileSync(infoPlist, 'utf8')
      let changed = false

      const replaceStringValue = (key, nextValue) => {
        const pattern = new RegExp(
          `(<key>${key}</key>\\s*<string>)([^<]+)(<\\/string>)`,
        )
        const match = plist.match(pattern)
        if (match && match[2] !== nextValue) {
          plist = plist.replace(pattern, `$1${nextValue}$3`)
          changed = true
        }
      }

      // Keep the dev Electron bundle identity aligned with Stella so macOS TCC
      // permissions target the desktop app instead of the generic Electron app.
      replaceStringValue('CFBundleName', DEV_MACOS_APP_NAME)
      replaceStringValue('CFBundleDisplayName', DEV_MACOS_APP_NAME)
      replaceStringValue('CFBundleIdentifier', DEV_MACOS_BUNDLE_ID)

      if (changed) {
        writeFileSync(infoPlist, plist)
      }
    }

    execSync(`touch "${distDir}"`, { stdio: 'ignore' })
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
}

const patchDevMicrophoneUsageDescription = () => {
  if (process.platform !== 'darwin') {
    return
  }

  const contentsDir = path.resolve(path.dirname(electronBinary), '..')
  const infoPlist = path.join(contentsDir, 'Info.plist')
  if (!existsSync(infoPlist)) {
    return
  }

  try {
    execSync(
      `plutil -replace NSMicrophoneUsageDescription -string ${JSON.stringify(MIC_USAGE_DESCRIPTION)} "${infoPlist}"`,
      { stdio: 'ignore' },
    )
  } catch {
    try {
      execSync(
        `plutil -insert NSMicrophoneUsageDescription -string ${JSON.stringify(MIC_USAGE_DESCRIPTION)} "${infoPlist}"`,
        { stdio: 'ignore' },
      )
    } catch {
      // Best-effort; read-only node_modules or unexpected plist shape.
    }
  }
}

if (process.platform === 'darwin') {
  patchDevIcon()
  patchDevAppName()
  patchDevMicrophoneUsageDescription()
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
let disclaimBinary = null

if (process.platform === 'darwin') {
  const disclaimSource = resolve(scriptDir, 'disclaim-spawn.c')
  disclaimBinary = resolve(devRuntimeRoot, 'disclaim-spawn')

  if (existsSync(disclaimSource)) {
    const needsBuild = !existsSync(disclaimBinary) ||
      statSync(disclaimSource).mtimeMs > statSync(disclaimBinary).mtimeMs

    if (needsBuild) {
      try {
        mkdirSync(devRuntimeRoot, { recursive: true })
        execFileSync('clang', ['-O2', '-o', disclaimBinary, disclaimSource], {
          stdio: 'ignore',
          timeout: 15_000,
        })
      } catch {
        console.warn('[electron-main] Failed to compile disclaim-spawn; macOS TCC prompts may not appear.')
        disclaimBinary = null
      }
    }
  } else {
    disclaimBinary = null
  }
}

const logError = (message) => {
  console.error(`[electron-main] ${message}`)
}

const wait = (ms) =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, ms)
  })

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const listStaleDevAppPids = () => {
  if (process.platform !== 'darwin') {
    return []
  }

  try {
    const stdout = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
    })
    const candidateCommands = new Set([
      electronBinary,
      legacyRuntimeElectronBinary,
      electronBinary.replace('/Stella.app/', '/Electron.app/'),
    ])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) {
          return []
        }

        const pid = Number(match[1])
        const command = match[2] ?? ''
        if (!Number.isInteger(pid) || pid === process.pid) {
          return []
        }

        for (const candidateCommand of candidateCommands) {
          const expectedCommandPrefix = `${candidateCommand} `
          if (
            command === candidateCommand
            || command === `${candidateCommand} .`
            || command.startsWith(expectedCommandPrefix)
          ) {
            return [pid]
          }
        }

        return []
      })
  } catch {
    return []
  }
}

const terminateStaleDevApps = async () => {
  const stalePids = listStaleDevAppPids()
  if (stalePids.length === 0) {
    return
  }

  logError(
    `found stale dev Stella process${stalePids.length === 1 ? '' : 'es'} (${stalePids.join(', ')}); terminating before launch.`,
  )

  for (const pid of stalePids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Ignore races if a stale process exits before termination.
    }
  }

  const deadline = Date.now() + staleAppShutdownTimeoutMs
  while (Date.now() < deadline) {
    const remaining = stalePids.filter((pid) => isPidAlive(pid))
    if (remaining.length === 0) {
      return
    }
    await wait(staleAppShutdownPollMs)
  }

  for (const pid of stalePids) {
    if (!isPidAlive(pid)) {
      continue
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Ignore races if a stale process exits during escalation.
    }
  }
}

const isRuntimeReloadPaused = () => {
  if (!existsSync(runtimeReloadStateFile)) {
    return false
  }
  try {
    const raw = JSON.parse(readFileSync(runtimeReloadStateFile, 'utf8'))
    return raw?.paused === true && isPidAlive(Number(raw?.pid))
  } catch {
    return false
  }
}

const flushDeferredRestartIfReady = () => {
  if (!pendingRestartWhilePaused || shuttingDown || isRuntimeReloadPaused()) {
    return
  }
  pendingRestartWhilePaused = false
  restartRequestedByWatcher = true
  scheduleRestart()
}

const startApp = () => {
  if (shuttingDown || currentApp) {
    return
  }

  const useDisclaim = disclaimBinary && existsSync(disclaimBinary)
  const spawnCmd = useDisclaim ? disclaimBinary : electronBinary
  const spawnArgs = useDisclaim ? [electronBinary, '.'] : ['.']

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      STELLA_DEV_INSECURE_PROTECTED_STORAGE: '1',
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

  await new Promise((resolveStop) => {
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true
      resolveStop()
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
  rootWatcher?.close()
  await stopApp()
  process.exit(exitCode)
}

await waitOn({
  resources: requiredFiles.map((filePath) => `file:${filePath}`),
})

await terminateStaleDevApps()

watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!shouldRestartElectronForBuildPath(filename)) {
    return
  }

  if (!watchReady) {
    scheduleWatchReady()
    return
  }

  if (isRuntimeReloadPaused()) {
    pendingRestartWhilePaused = true
    return
  }

  restartRequestedByWatcher = true
  scheduleRestart()
})

rootWatcher = watch(projectDir, (_eventType, filename) => {
  if (
    typeof filename !== 'string' ||
    filename !== path.basename(runtimeReloadStateFile)
  ) {
    return
  }
  flushDeferredRestartIfReady()
})

startApp()
scheduleWatchReady()

process.once('SIGINT', () => {
  void shutdown(130)
})

process.once('SIGTERM', () => {
  void shutdown(143)
})
