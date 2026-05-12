import { execFileSync, execSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  watch,
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
const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const repoRootDir = resolve(desktopDir, '..')
let electronBinary = require('electron')
const watchedDir = path.join(desktopDir, 'dist-electron')
const runtimeReloadStateFile = path.join(
  repoRootDir,
  '.stella-runtime-reload-state.json',
)
const devRuntimeRoot = path.join(desktopDir, DEV_MACOS_RUNTIME_DIR_NAME)
const prebuiltDisclaimBinary = path.join(
  desktopDir,
  'native',
  'out',
  'darwin',
  'disclaim-spawn',
)
const legacyRuntimeElectronBinary = path.join(
  devRuntimeRoot,
  'Stella.app',
  'Contents',
  'MacOS',
  'Electron',
)
const requiredFiles = [
  path.join(desktopDir, '.vite-dev-url'),
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

/**
 * Last-seen content hash for every restart-relevant build output under
 * `dist-electron/`. The fs watcher fires on mtime/write events, but
 * esbuild's incremental rebuild (`context.watch()`) sometimes rewrites
 * a bundle with byte-identical content as a side effect of unrelated
 * package-manager operations — `bunx --package <pkg> tsc …` taps the
 * tsconfig graph + bun cache enough that esbuild flushes the output
 * even though the source is unchanged.
 *
 * Without a content gate, that spurious rewrite tears down Electron
 * (and the in-flight self-mod morph cover with it) for nothing. We
 * record the hash on every observed change and skip the restart when
 * the new bytes match the previous emit.
 *
 * `null` here means "the file has been deleted"; `undefined` means
 * "we have not seen this path before".
 */
const lastBuildHashes = new Map()

const readHash = (filePath) => {
  if (!existsSync(filePath)) {
    return null
  }
  return createHash('md5').update(readFileSync(filePath)).digest('hex')
}

/**
 * Walk `dist-electron/` once at startup and record the hash of every
 * file matching the restart filter. The first `watch` events that
 * fire after a cold start would otherwise look like "first sighting"
 * for each path (`previousHash === undefined`) and trip a restart on
 * the next esbuild touch even when the bytes haven't changed.
 */
const seedLastBuildHashes = () => {
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(absPath)
        continue
      }
      if (!entry.isFile()) continue
      const relPath = path.relative(watchedDir, absPath)
      if (!shouldRestartElectronForBuildPath(relPath)) continue
      const hash = readHash(absPath)
      if (hash != null) lastBuildHashes.set(absPath, hash)
    }
  }
  visit(watchedDir)
}

/**
 * Packaged apps get NSMicrophoneUsageDescription from electron-builder extendInfo.
 * The stock Electron.app in node_modules does not, so macOS never shows the mic
 * prompt for getUserMedia in dev — inject the same string we ship in production.
 */
const MIC_USAGE_DESCRIPTION =
  'Stella uses your microphone for voice conversations.'

const patchDevIcon = () => {
  const appIcon = path.join(desktopDir, 'build', 'icon.icns')
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

/**
 * Re-apply an ad-hoc bundle signature after the patch helpers above mutate
 * `Info.plist`. Electron ships an ad-hoc Mach-O signature whose CodeDirectory
 * hashes the bundle resources; once we change `CFBundleName` /
 * `CFBundleIdentifier` / `NSMicrophoneUsageDescription` the recorded hash
 * stops matching and macOS surfaces a "Stella was modified or has a damaged
 * signature" notification on launch (and may invalidate TCC permissions).
 *
 * `codesign --force --deep --sign -` re-seals the bundle with a fresh ad-hoc
 * signature consistent with the modified contents. No certificate, keychain,
 * Apple ID, or Xcode CLT required — `codesign` is a base macOS binary at
 * `/usr/bin/codesign`. The trust level stays the same (ad-hoc, no developer
 * id), it's just internally consistent again. Same idiom as the wake-word
 * helper (`desktop/native/build.sh`).
 */
const resignDevAppBundle = () => {
  if (process.platform !== 'darwin') {
    return
  }
  const appBundle = path.resolve(path.dirname(electronBinary), '..', '..')
  if (!existsSync(appBundle) || !appBundle.endsWith('.app')) {
    return
  }
  try {
    execFileSync('codesign', ['--verify', '--no-strict', appBundle], {
      stdio: 'ignore',
    })
    return
  } catch (verifyError) {
    if (verifyError?.code === 'ENOENT') {
      // codesign missing — no-op rather than fail dev startup.
      return
    }
    // Signature broken or missing; fall through to re-sign.
  }
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', appBundle],
      { stdio: 'ignore' },
    )
  } catch {
    // Best-effort; read-only node_modules or unsupported signing flags.
  }
}

if (process.platform === 'darwin') {
  patchDevIcon()
  patchDevAppName()
  patchDevMicrophoneUsageDescription()
  resignDevAppBundle()
}
let disclaimBinary = null

if (process.platform === 'darwin') {
  const disclaimSource = resolve(scriptDir, 'disclaim-spawn.c')
  const fallbackDisclaimBinary = resolve(devRuntimeRoot, 'disclaim-spawn')

  // Launcher-installed users should use a shipped helper so first launch does
  // not depend on Xcode Command Line Tools being present.
  if (existsSync(prebuiltDisclaimBinary)) {
    disclaimBinary = prebuiltDisclaimBinary
  } else if (existsSync(disclaimSource)) {
    disclaimBinary = fallbackDisclaimBinary
    try {
      mkdirSync(devRuntimeRoot, { recursive: true })
      execFileSync('clang', ['-O2', '-o', disclaimBinary, disclaimSource], {
        stdio: 'ignore',
        timeout: 15_000,
      })
    } catch {
      console.warn(
        '[electron-main] Failed to compile disclaim-spawn; macOS TCC prompts may not appear.',
      )
      disclaimBinary = null
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
            command === candidateCommand ||
            command === `${candidateCommand} .` ||
            command.startsWith(expectedCommandPrefix)
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
    cwd: repoRootDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      STELLA_DEV_SPLASH_READY_FILE: splashReadyFile,
      ...(process.env.STELLA_LAUNCHER_PROTECTED_STORAGE_BIN
        ? {}
        : { STELLA_DEV_INSECURE_PROTECTED_STORAGE: '1' }),
    },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
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

    const signalAppProcess = (signal) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        return
      }
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall back to the direct child below.
        }
      }
      try {
        child.kill(signal)
      } catch {
        // Ignore races during shutdown.
      }
    }

    child.once('exit', finish)
    signalAppProcess('SIGTERM')

    setTimeout(() => {
      if (settled) {
        return
      }

      signalAppProcess('SIGKILL')
      finish()
    }, forcedShutdownTimeoutMs).unref()
  })
}

/**
 * Pre-restart splash window. Shown briefly between killing the current
 * Electron and spawning the next one so the user sees "Restarting to
 * apply change..." instead of a stretch of blank desktop. With the
 * detached worker, in-flight runs survive across this restart, so the
 * splash is honest — no work is being lost behind it.
 *
 * Implemented via a tiny standalone Electron process loading an inline
 * data: URL. Killed automatically once the new Electron emits its
 * first ready signal (it touches a sentinel file), or after a 10s
 * fallback so a startup hang doesn't leave the splash stranded.
 */
let splashChild = null
const splashSentinelFile = path.join(repoRootDir, '.stella-dev-splash.lock')
const splashReadyFile = path.join(repoRootDir, '.stella-dev-splash.ready')
const splashMainFile = path.join(repoRootDir, '.stella-dev-splash-main.cjs')
const splashFallbackTimeoutMs = 10_000

const writeSplashHtml = () => {
  const tmpHtml = path.join(repoRootDir, '.stella-dev-splash.html')
  // Resolve assets via file:// URLs so the splash works without Vite.
  // Use the same Stella logo + Cormorant Garamond italic the launcher uses
  // so the dev restart reads as a polished "Stella is reloading" moment
  // rather than a debug overlay.
  const logoUrl = `file://${path.join(repoRootDir, 'desktop/public/stella-logo.svg')}`
  const fontUrl = `file://${path.join(repoRootDir, 'launcher/src/assets/fonts/cormorant-garamond-italic.ttf')}`
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Stella</title>
<style>
  @font-face {
    font-family: "Cormorant Garamond";
    src: url("${fontUrl}") format("truetype");
    font-display: block;
    font-style: italic;
    font-weight: 400;
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 100%;
    background: transparent;
    color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    user-select: none;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .card {
    width: 100%;
    height: 100%;
    background: #ffffff;
    border-radius: 14px;
    /* Intentionally no box-shadow: Chromium can't composite a real
       drop-shadow past a transparent window's bounds, so the shadow
       renders as a dark square inside the window frame. The 1px
       border below gives the card a clean edge instead. */
    border: 1px solid rgba(0, 0, 0, 0.06);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 22px 24px;
    animation: cardIn 220ms cubic-bezier(0.32, 0.72, 0, 1) both;
  }
  .logo {
    width: 48px;
    height: 48px;
  }
  .status {
    font-size: 11.5px;
    color: #86868b;
    letter-spacing: 0.005em;
    text-align: center;
  }
  @keyframes cardIn {
    from { opacity: 0; transform: translateY(4px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
  }
</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="${logoUrl}" alt="Stella" />
    <div class="status">Reloading to apply changes</div>
  </div>
</body>
</html>`
  writeFileSync(tmpHtml, html, 'utf8')
  return tmpHtml
}

const showRestartSplash = () => {
  if (splashChild || shuttingDown) return
  try {
    const splashHtml = writeSplashHtml()
    const splashScript = `
      const { app, BrowserWindow } = require('electron')
      const path = require('path')
      const fs = require('fs')
      // The splash is a separate Electron process spawned outside of our
      // main bootstrap. Without these switches Chromium initializes its
      // OSCrypt cookie store on startup, which on macOS reads the
      // "Electron Safe Storage" Keychain entry -- triggering the macOS
      // permission prompt every restart. The main app already sets these
      // in bootstrap.ts; the splash needs the same defense because it
      // never loads our bootstrap.
      app.commandLine.appendSwitch('use-mock-keychain')
      app.commandLine.appendSwitch('password-store', 'basic')
      app.dock?.hide()
      app.whenReady().then(() => {
        const win = new BrowserWindow({
          width: 280,
          height: 200,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          hasShadow: false,
          alwaysOnTop: true,
          resizable: false,
          movable: false,
          show: false,
          skipTaskbar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
        win.loadFile(${JSON.stringify(splashHtml)}).then(() => win.show())
        const sentinel = ${JSON.stringify(splashSentinelFile)}
        const ready = ${JSON.stringify(splashReadyFile)}
        const interval = setInterval(() => {
          if (!fs.existsSync(sentinel) || fs.existsSync(ready)) {
            clearInterval(interval)
            try { fs.unlinkSync(sentinel) } catch {}
            try { fs.unlinkSync(ready) } catch {}
            try { fs.unlinkSync(__filename) } catch {}
            try { win.close() } catch {}
            app.quit()
          }
        }, 100)
        const fallback = setTimeout(() => {
          try { fs.unlinkSync(sentinel) } catch {}
          try { fs.unlinkSync(__filename) } catch {}
          try { win.close() } catch {}
          app.quit()
        }, ${splashFallbackTimeoutMs})
        fallback.unref?.()
      })
    `
    rmSync(splashReadyFile, { force: true })
    writeFileSync(splashSentinelFile, String(Date.now()), 'utf8')
    writeFileSync(splashMainFile, splashScript, 'utf8')
    splashChild = spawn(electronBinary, [splashMainFile], {
      cwd: repoRootDir,
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    })
    splashChild.unref?.()
    splashChild.once('exit', () => {
      splashChild = null
    })
  } catch {
    splashChild = null
  }
}

const dismissRestartSplash = () => {
  try {
    if (existsSync(splashSentinelFile)) {
      rmSync(splashSentinelFile, { force: true })
    }
    if (existsSync(splashReadyFile)) {
      rmSync(splashReadyFile, { force: true })
    }
    if (existsSync(splashMainFile)) {
      rmSync(splashMainFile, { force: true })
    }
  } catch {
    // The splash also has its own fallback timeout, so a failed unlink
    // just means the splash stays for ~10s longer.
  }
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
        showRestartSplash()
        await stopApp()
        if (!shuttingDown) {
          restartRequestedByWatcher = false
          startApp()
        } else {
          dismissRestartSplash()
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
  dismissRestartSplash()
  await stopApp()
  process.exit(exitCode)
}

await waitOn({
  resources: requiredFiles.map((filePath) => `file:${filePath}`),
})

await terminateStaleDevApps()

seedLastBuildHashes()

watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!shouldRestartElectronForBuildPath(filename)) {
    return
  }

  // Content gate: only honor the watcher tick when the file's bytes
  // actually changed. esbuild routinely rewrites identical output as
  // a side effect of upstream watchers (tsconfig graph reaches into
  // node_modules, bunx mutates bun.lock, etc.). Restarting Electron
  // for those is the visible failure that kills self-mod morph
  // covers.
  const absPath = path.join(watchedDir, filename)
  const currentHash = readHash(absPath)
  const previousHash = lastBuildHashes.has(absPath)
    ? lastBuildHashes.get(absPath)
    : undefined
  if (previousHash !== undefined && currentHash === previousHash) {
    return
  }
  lastBuildHashes.set(absPath, currentHash)

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

rootWatcher = watch(repoRootDir, (_eventType, filename) => {
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
