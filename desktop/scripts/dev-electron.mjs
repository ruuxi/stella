import { execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
} from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import waitOn from 'wait-on'
import { shouldRestartElectronForBuildPath } from './dev-electron-restart-filter.mjs'

const require = createRequire(import.meta.url)
const DEV_MACOS_APP_NAME = 'Stella'
const DEV_MACOS_BUNDLE_ID = 'com.stella.app'
const DEV_MACOS_RUNTIME_DIR_NAME = '.stella-dev-runtime'
const DEV_MACOS_RUNTIME_APP_NAME = 'Stella.app'
const DEV_MACOS_RUNTIME_FORMAT_VERSION = 3
const projectDir = process.cwd()
let electronBinary = require('electron')
const watchedDir = path.join(projectDir, 'dist-electron')
const runtimeReloadStateFile = path.join(projectDir, '.stella-runtime-reload-state.json')
const devRuntimeRoot = path.join(projectDir, DEV_MACOS_RUNTIME_DIR_NAME)
const devRuntimeSourceRoot = path.join(devRuntimeRoot, 'source')
const devRuntimeSourceAppBundle = path.join(
  devRuntimeSourceRoot,
  DEV_MACOS_RUNTIME_APP_NAME,
)
const devRuntimeSourceManifestPath = path.join(
  devRuntimeRoot,
  'source-manifest.json',
)
const devRuntimeAppBundle = path.join(devRuntimeRoot, DEV_MACOS_RUNTIME_APP_NAME)
const devRuntimeManifestPath = path.join(devRuntimeRoot, 'manifest.json')
const requiredFiles = [
  path.join(projectDir, '.vite-dev-url'),
  path.join(watchedDir, 'electron', 'main.js'),
  path.join(watchedDir, 'electron', 'preload.js'),
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
let restartRequestedByWatcher = false
let exitCode = 0
let rootWatcher = null
let pendingRestartWhilePaused = false
const expectedExits = new WeakSet()

const getAppBundlePath = (binaryPath) =>
  path.resolve(path.dirname(binaryPath), '..', '..')

const getAppExecutablePath = (appBundlePath) =>
  path.join(appBundlePath, 'Contents', 'MacOS', 'Electron')

const electronPackageDir = path.dirname(require.resolve('electron/package.json'))
const stockElectronAppBundlePath = path.join(
  electronPackageDir,
  'dist',
  'Electron.app',
)

const readHash = (filePath) => {
  if (!existsSync(filePath)) {
    return null
  }
  return createHash('md5').update(readFileSync(filePath)).digest('hex')
}

const readJsonFile = (filePath) => {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

const buildAppManifest = (sourceAppBundlePath) => {
  let electronVersion = 'unknown'
  try {
    electronVersion = require('electron/package.json').version
  } catch {
    // Ignore; the source executable timestamp still gives us a sync signal.
  }

  const sourceExecutable = getAppExecutablePath(sourceAppBundlePath)
  const sourceExecutableMtimeMs = existsSync(sourceExecutable)
    ? Math.round(statSync(sourceExecutable).mtimeMs)
    : 0

  return {
    runtimeFormatVersion: DEV_MACOS_RUNTIME_FORMAT_VERSION,
    electronVersion,
    sourceAppBundlePath,
    sourceExecutableMtimeMs,
    appName: DEV_MACOS_APP_NAME,
    bundleId: DEV_MACOS_BUNDLE_ID,
    iconHash: readHash(path.join(projectDir, 'build', 'icon.icns')),
  }
}

const upsertPlistString = (plist, key, nextValue) => {
  const pattern = new RegExp(
    `(<key>${key}</key>\\s*<string>)([^<]*)(<\\/string>)`,
  )
  const match = plist.match(pattern)
  if (match) {
    if (match[2] === nextValue) {
      return { plist, changed: false }
    }
    return {
      plist: plist.replace(pattern, `$1${nextValue}$3`),
      changed: true,
    }
  }

  const marker = '</dict>'
  const insertion =
    `\t<key>${key}</key>\n` +
    `\t<string>${nextValue}</string>\n`
  if (!plist.includes(marker)) {
    return { plist, changed: false }
  }
  return {
    plist: plist.replace(marker, `${insertion}${marker}`),
    changed: true,
  }
}

const patchRuntimeIcon = (appBundlePath) => {
  const appIcon = path.join(projectDir, 'build', 'icon.icns')
  const appBundle = path.join(appBundlePath, 'Contents')
  const electronIcon = path.join(appBundle, 'Resources', 'electron.icns')
  if (!existsSync(appIcon) || !existsSync(electronIcon)) {
    return false
  }

  const srcHash = readHash(appIcon)
  const dstHash = readHash(electronIcon)
  if (srcHash === dstHash) {
    return false
  }

  try {
    copyFileSync(appIcon, electronIcon)
    return true
  } catch {
    // Best-effort; may fail if the copied bundle is temporarily locked.
    return false
  }
}

const patchRuntimeInfoPlist = (appBundlePath) => {
  const infoPlist = path.join(appBundlePath, 'Contents', 'Info.plist')
  if (!existsSync(infoPlist)) {
    return false
  }

  let plist = readFileSync(infoPlist, 'utf8')
  let changed = false

  for (const [key, value] of [
    ['CFBundleName', DEV_MACOS_APP_NAME],
    ['CFBundleDisplayName', DEV_MACOS_APP_NAME],
    ['CFBundleIdentifier', DEV_MACOS_BUNDLE_ID],
    ['NSMicrophoneUsageDescription', MIC_USAGE_DESCRIPTION],
  ]) {
    const result = upsertPlistString(plist, key, value)
    plist = result.plist
    changed ||= result.changed
  }

  if (!changed) {
    return false
  }
  try {
    writeFileSync(infoPlist, plist)
    return true
  } catch {
    // Best-effort; may fail if the copied bundle is temporarily locked.
    return false
  }
}

/**
 * Packaged apps get NSMicrophoneUsageDescription from electron-builder extendInfo.
 * The copied dev app needs the same key so macOS can prompt for getUserMedia.
 */
const MIC_USAGE_DESCRIPTION =
  'Stella uses your microphone for voice conversations and wake-word listening.'

const signRuntimeAppBundle = (appBundlePath) => {
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', appBundlePath],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

const verifyRuntimeAppBundle = (appBundlePath) => {
  try {
    execFileSync(
      'codesign',
      ['--verify', '--deep', '--strict', appBundlePath],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

if (process.platform === 'darwin') {
  // Always seed from the stock Electron.app in the package rather than
  // electron/path.txt, which can drift between worktrees and installed copies.
  const sourceAppBundlePath = existsSync(stockElectronAppBundlePath)
    ? stockElectronAppBundlePath
    : getAppBundlePath(electronBinary)
  const expectedSourceManifest = buildAppManifest(sourceAppBundlePath)
  const currentSourceManifest = readJsonFile(devRuntimeSourceManifestPath)
  const sourceManifestMatches =
    currentSourceManifest
    && JSON.stringify(currentSourceManifest) === JSON.stringify(expectedSourceManifest)

  let didCopySource = false
  if (!existsSync(devRuntimeSourceAppBundle) || !sourceManifestMatches) {
    rmSync(devRuntimeSourceAppBundle, { recursive: true, force: true })
    mkdirSync(devRuntimeSourceRoot, { recursive: true })
    cpSync(sourceAppBundlePath, devRuntimeSourceAppBundle, {
      recursive: true,
      verbatimSymlinks: true,
    })
    didCopySource = true
  }

  const didPatchSourceIcon = patchRuntimeIcon(devRuntimeSourceAppBundle)
  const didPatchSourcePlist = patchRuntimeInfoPlist(devRuntimeSourceAppBundle)
  const didPatchSource = didPatchSourceIcon || didPatchSourcePlist
  const sourceVerifiedBeforeSign = verifyRuntimeAppBundle(devRuntimeSourceAppBundle)
  const needsSourceSigning =
    didCopySource || didPatchSource || !sourceVerifiedBeforeSign
  const sourceSignSucceeded =
    !needsSourceSigning || signRuntimeAppBundle(devRuntimeSourceAppBundle)

  if (needsSourceSigning && !sourceSignSucceeded) {
    console.warn('[electron-main] Failed to ad-hoc sign stable source Stella.app; macOS permissions may not persist across restarts.')
  }

  writeFileSync(
    devRuntimeSourceManifestPath,
    `${JSON.stringify(expectedSourceManifest, null, 2)}\n`,
    'utf8',
  )

  const expectedManifest = buildAppManifest(devRuntimeSourceAppBundle)
  const currentManifest = readJsonFile(devRuntimeManifestPath)
  const manifestMatches =
    currentManifest
    && JSON.stringify(currentManifest) === JSON.stringify(expectedManifest)

  let didCopy = false
  if (!existsSync(devRuntimeAppBundle) || !manifestMatches) {
    rmSync(devRuntimeAppBundle, { recursive: true, force: true })
    mkdirSync(devRuntimeRoot, { recursive: true })
    cpSync(devRuntimeSourceAppBundle, devRuntimeAppBundle, {
      recursive: true,
      verbatimSymlinks: true,
    })
    didCopy = true
  }

  const didPatchIcon = patchRuntimeIcon(devRuntimeAppBundle)
  const didPatchPlist = patchRuntimeInfoPlist(devRuntimeAppBundle)
  const didPatch = didPatchIcon || didPatchPlist
  const verifiedBeforeSign = verifyRuntimeAppBundle(devRuntimeAppBundle)
  const needsSigning = didCopy || didPatch || !verifiedBeforeSign
  const signSucceeded = !needsSigning || signRuntimeAppBundle(devRuntimeAppBundle)

  if (needsSigning && !signSucceeded) {
    console.warn('[electron-main] Failed to ad-hoc sign stable dev Stella.app; macOS permissions may not persist across restarts.')
  }

  writeFileSync(
    devRuntimeManifestPath,
    `${JSON.stringify(expectedManifest, null, 2)}\n`,
    'utf8',
  )
  electronBinary = getAppExecutablePath(devRuntimeAppBundle)
}

const logError = (message) => {
  console.error(`[electron-main] ${message}`)
}

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

  const child = spawn(electronBinary, ['.'], {
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
  rootWatcher?.close()
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
