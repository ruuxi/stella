import { execFileSync, execSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
} from 'node:fs'
import { resolve } from 'node:path'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import waitOn from 'wait-on'
import { shouldRestartElectronForBuildPath } from './dev-electron-restart-filter.mjs'

const require = createRequire(import.meta.url)
const DEV_MACOS_APP_NAME = 'Stella'
const DEV_MACOS_BUNDLE_ID = 'com.stella.app'
const DEV_MACOS_RUNTIME_DIR_NAME = '.stella-dev-runtime'
const DEV_BARE_RELAUNCH_EXECUTABLE = 'StellaDevRelaunch'
const LEGACY_DEV_PROTOCOL_APP_NAME = 'stella-dev-protocol-app'
const scriptDir = import.meta.dirname
const desktopDir = resolve(scriptDir, '..')
const repoRootDir = resolve(desktopDir, '..')
let electronBinary = require('electron')
const watchedDir = path.join(desktopDir, 'dist-electron')
const runtimeReloadStateFile = path.join(
  repoRootDir,
  '.stella-runtime-reload-state.json',
)
const devRestartRequestFile = path.join(
  repoRootDir,
  '.stella-dev-restart-request',
)
// Records the pid of the currently-launched Electron app so the next dev
// start can reap a leftover tree. On macOS `terminateStaleDevApps` scans
// `ps` by image path; Windows has no cheap image-path scan, so we persist
// the pid and `taskkill /T` it on the next launch instead.
const devAppPidFile = path.join(desktopDir, '.electron-dev-app.pid')
const devRuntimeRoot = path.join(desktopDir, DEV_MACOS_RUNTIME_DIR_NAME)
const prebuiltDisclaimBinary = path.join(
  desktopDir,
  'native',
  'out',
  'darwin',
  'disclaim-spawn',
)
const windowsStartupFeedbackLauncher = path.join(
  desktopDir,
  'native',
  'out',
  'win32',
  'startup_feedback_launcher.exe',
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
const devRestartRequestGraceMs = 2_000
const buildOutputSettleQuietMs = 350
const buildOutputSettleTimeoutMs = 5_000
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
 * Last-seen `{ size, mtimeMs, hash }` fingerprint for every restart-relevant
 * build output under `dist-electron/`. The fs watcher fires on mtime/write
 * events, but the dev compiler watchers can rewrite byte-identical output as a
 * side effect of unrelated package-manager operations — `bunx --package <pkg>
 * tsc …` taps the tsconfig graph + bun cache enough that output can flush even
 * though the source is unchanged.
 *
 * Without a content gate, that spurious rewrite tears down Electron
 * (and the in-flight self-mod morph cover with it) for nothing. The `hash`
 * stays the source of truth for the gate so a byte-identical rewrite (same
 * bytes, fresh mtime) is still suppressed; the `size`/`mtimeMs` pair is only a
 * cheap pre-check that lets us skip re-reading multi-MB outputs (notably the
 * big main.js) when stat proves the file is unchanged — avoiding the second
 * full read the first post-cold-start watcher tick would otherwise pay.
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

// Cheap stat fingerprint used to short-circuit the multi-MB content read when
// size+mtime prove the file is unchanged since we last hashed it. Returns null
// when the file is missing (mirrors readHash's deletion semantics).
const readBuildStat = (filePath) => {
  try {
    const stats = statSync(filePath)
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const getLatestRestartRelevantBuildMtimeMs = () => {
  let latestMtimeMs = 0
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
      try {
        latestMtimeMs = Math.max(latestMtimeMs, statSync(absPath).mtimeMs)
      } catch {
        // Ignore files that disappear while esbuild is rewriting the tree.
      }
    }
  }
  visit(watchedDir)
  return latestMtimeMs
}

const waitForBuildOutputsToSettle = async () => {
  const startedAt = Date.now()
  while (!shuttingDown) {
    const latestMtimeMs = getLatestRestartRelevantBuildMtimeMs()
    if (latestMtimeMs === 0 || Date.now() - latestMtimeMs >= buildOutputSettleQuietMs) {
      return
    }
    if (Date.now() - startedAt >= buildOutputSettleTimeoutMs) {
      return
    }
    await sleep(75)
  }
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
      if (hash == null) continue
      // Capture the stat fingerprint next to the hash so the first watcher tick
      // after cold start can skip re-reading the (multi-MB) file when size+mtime
      // still match — the content gate's byte-identical suppression is unchanged
      // because `hash` remains the comparison key whenever stat does differ.
      const stat = readBuildStat(absPath)
      lastBuildHashes.set(absPath, {
        hash,
        size: stat?.size,
        mtimeMs: stat?.mtimeMs,
      })
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
    return false
  }

  const srcHash = readHash(appIcon)
  const dstHash = readHash(electronIcon)
  if (srcHash === dstHash) {
    return false
  }

  try {
    copyFileSync(appIcon, electronIcon)
    if (existsSync(infoPlist)) {
      execSync(`touch "${path.join(appBundle, '..')}"`, { stdio: 'ignore' })
    }
    return true
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
  return false
}

const patchDevAppName = () => {
  let changed = false
  const distDir = path.resolve(path.dirname(electronBinary), '..', '..', '..')
  const oldBundle = path.join(distDir, 'Electron.app')
  const newBundle = path.join(distDir, 'Stella.app')
  const pathTxtFile = path.resolve(distDir, '..', 'path.txt')
  const hasOldBundle = existsSync(oldBundle)
  const hasNewBundle = existsSync(newBundle)

  if (!hasOldBundle && !hasNewBundle) {
    return false
  }

  try {
    if (hasOldBundle && !hasNewBundle) {
      renameSync(oldBundle, newBundle)
      changed = true
    }
    electronBinary = electronBinary.replace('Electron.app', 'Stella.app')

    if (existsSync(pathTxtFile)) {
      const pathTxt = readFileSync(pathTxtFile, 'utf8')
      const nextPathTxt = pathTxt.replace('Electron.app', 'Stella.app')
      if (nextPathTxt !== pathTxt) {
        writeFileSync(pathTxtFile, nextPathTxt)
        changed = true
      }
    }

    const infoPlist = path.join(newBundle, 'Contents', 'Info.plist')
    if (existsSync(infoPlist)) {
      let plist = readFileSync(infoPlist, 'utf8')
      let plistChanged = false

      const replaceStringValue = (key, nextValue) => {
        const pattern = new RegExp(
          `(<key>${key}</key>\\s*<string>)([^<]+)(<\\/string>)`,
        )
        const match = plist.match(pattern)
        if (match && match[2] !== nextValue) {
          plist = plist.replace(pattern, `$1${nextValue}$3`)
          plistChanged = true
        }
      }

      // Keep the dev Electron bundle identity aligned with Stella so macOS TCC
      // permissions target the desktop app instead of the generic Electron app.
      replaceStringValue('CFBundleName', DEV_MACOS_APP_NAME)
      replaceStringValue('CFBundleDisplayName', DEV_MACOS_APP_NAME)
      replaceStringValue('CFBundleIdentifier', DEV_MACOS_BUNDLE_ID)

      if (plistChanged) {
        writeFileSync(infoPlist, plist)
        changed = true
      }
    }

    if (changed) {
      execSync(`touch "${distDir}"`, { stdio: 'ignore' })
    }
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
  return changed
}

const patchDevMicrophoneUsageDescription = () => {
  if (process.platform !== 'darwin') {
    return false
  }

  const contentsDir = path.resolve(path.dirname(electronBinary), '..')
  const infoPlist = path.join(contentsDir, 'Info.plist')
  if (!existsSync(infoPlist)) {
    return false
  }

  try {
    const existing = execFileSync(
      'plutil',
      ['-extract', 'NSMicrophoneUsageDescription', 'raw', infoPlist],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (existing === MIC_USAGE_DESCRIPTION) {
      return false
    }
  } catch {
    // Missing key or unexpected plist; fall through to set it.
  }

  try {
    execSync(
      `plutil -replace NSMicrophoneUsageDescription -string ${JSON.stringify(MIC_USAGE_DESCRIPTION)} "${infoPlist}"`,
      { stdio: 'ignore' },
    )
    return true
  } catch {
    try {
      execSync(
        `plutil -insert NSMicrophoneUsageDescription -string ${JSON.stringify(MIC_USAGE_DESCRIPTION)} "${infoPlist}"`,
        { stdio: 'ignore' },
      )
      return true
    } catch {
      // Best-effort; read-only node_modules or unexpected plist shape.
    }
  }
  return false
}

const ensureDevBareRelaunchExecutable = () => {
  if (process.platform !== 'darwin') {
    return false
  }

  let changed = false
  const contentsDir = path.resolve(path.dirname(electronBinary), '..')
  const infoPlist = path.join(contentsDir, 'Info.plist')
  const macosDir = path.join(contentsDir, 'MacOS')
  const relaunchExecutablePath = path.join(macosDir, DEV_BARE_RELAUNCH_EXECUTABLE)
  const resourcesAppDir = path.join(contentsDir, 'Resources', 'app')
  const resourcesAppPackageJson = path.join(resourcesAppDir, 'package.json')

  try {
    if (existsSync(resourcesAppPackageJson)) {
      const packageJson = JSON.parse(
        readFileSync(resourcesAppPackageJson, 'utf8'),
      )
      const knownShimNames = new Set([
        LEGACY_DEV_PROTOCOL_APP_NAME,
        'stella-dev-bare-relaunch-app',
      ])
      if (knownShimNames.has(packageJson?.name)) {
        rmSync(resourcesAppDir, { force: true, recursive: true })
        changed = true
      }
    }

    const relaunchScript = `#!/bin/zsh
set -e

repo_root=${JSON.stringify(repoRootDir)}
electron_bin="$(cd "$(dirname "$0")" && pwd)/Electron"
restart_file=${JSON.stringify(devRestartRequestFile)}
runner_pid_file=${JSON.stringify(path.join(desktopDir, '.electron-dev-runner.pid'))}
runner_script=${JSON.stringify(path.join(desktopDir, 'scripts', 'electron-dev-runner.mjs'))}
node_bin=${JSON.stringify(process.execPath)}

non_launch_args=()
for arg in "$@"; do
  case "$arg" in
    -psn_*) ;;
    *) non_launch_args+=("$arg") ;;
  esac
done

if [ "\${#non_launch_args[@]}" -eq 0 ]; then
  runner_pid=""
  if [ -f "$runner_pid_file" ]; then
    runner_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$runner_pid_file" | head -n 1)"
  fi

  if [ -n "$runner_pid" ] && kill -0 "$runner_pid" 2>/dev/null; then
    date +%s > "$restart_file"
    exit 0
  fi

  cd "$repo_root"
  exec "$node_bin" "$runner_script"
fi

cd "$repo_root"
if [ "\${non_launch_args[1]-}" != "." ]; then
  non_launch_args=("." "\${non_launch_args[@]}")
fi
export NODE_ENV=development
export STELLA_DEV_RESTART_REQUEST_FILE="$restart_file"
if [ -z "$STELLA_LAUNCHER_PROTECTED_STORAGE_BIN" ]; then
  export STELLA_DEV_INSECURE_PROTECTED_STORAGE=1
fi
exec "$electron_bin" "\${non_launch_args[@]}"
`

    if (
      !existsSync(relaunchExecutablePath) ||
      readFileSync(relaunchExecutablePath, 'utf8') !== relaunchScript
    ) {
      writeFileSync(relaunchExecutablePath, relaunchScript, 'utf8')
      changed = true
    }
    try {
      const mode = statSync(relaunchExecutablePath).mode & 0o777
      if (mode !== 0o755) {
        chmodSync(relaunchExecutablePath, 0o755)
        changed = true
      }
    } catch {
      chmodSync(relaunchExecutablePath, 0o755)
      changed = true
    }

    if (existsSync(infoPlist)) {
      let currentExecutable = ''
      try {
        currentExecutable = execFileSync(
          'plutil',
          ['-extract', 'CFBundleExecutable', 'raw', infoPlist],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim()
      } catch {
        // Missing key or unexpected plist; fall through to replace it.
      }
      if (currentExecutable !== DEV_BARE_RELAUNCH_EXECUTABLE) {
        execFileSync(
          'plutil',
          [
            '-replace',
            'CFBundleExecutable',
            '-string',
            DEV_BARE_RELAUNCH_EXECUTABLE,
            infoPlist,
          ],
          { stdio: 'ignore' },
        )
        changed = true
      }
    }
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
  return changed
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
const resignDevAppBundle = (force = false) => {
  if (process.platform !== 'darwin') {
    return
  }
  const appBundle = path.resolve(path.dirname(electronBinary), '..', '..')
  if (!existsSync(appBundle) || !appBundle.endsWith('.app')) {
    return
  }
  if (!force) {
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
  const bundleChanged = [
    patchDevIcon(),
    patchDevAppName(),
    patchDevMicrophoneUsageDescription(),
    ensureDevBareRelaunchExecutable(),
  ].some(Boolean)
  resignDevAppBundle(bundleChanged)
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

const readDevAppPid = () => {
  try {
    const pid = Number.parseInt(readFileSync(devAppPidFile, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const writeDevAppPid = (pid) => {
  try {
    writeFileSync(devAppPidFile, String(pid), 'utf8')
  } catch {
    // Best-effort; without it the next start just can't reap this pid.
  }
}

const clearDevAppPid = () => {
  try {
    rmSync(devAppPidFile, { force: true })
  } catch {
    // Ignore stale/missing pid files during shutdown.
  }
}

// Confirm a recorded pid still belongs to Electron before killing its tree,
// guarding against pid reuse. `tasklist` with a single PID filter is cheap
// (no full WMI/CIM enumeration), unlike the PowerShell scans elsewhere.
const isWindowsPidElectron = (pid) => {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true },
    ).toLowerCase()
    return out.includes('electron.exe') || out.includes('stella')
  } catch {
    return false
  }
}

const terminateStaleWindowsDevApp = async () => {
  const pid = readDevAppPid()
  if (
    pid === null ||
    pid === process.pid ||
    !isPidAlive(pid) ||
    !isWindowsPidElectron(pid)
  ) {
    clearDevAppPid()
    return
  }

  logError(`found stale dev Electron process (${pid}); terminating tree before launch.`)
  await new Promise((resolveKill) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => resolveKill())
    killer.on('exit', () => resolveKill())
  })
  clearDevAppPid()
}

// SIGTERM-then-SIGKILL a detached app's process group (it is its own group
// leader because startApp spawns it detached), mirroring the escalation used
// for the full ps-scan path below.
const terminateDarwinPidTree = async (pid) => {
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Fall back to the direct pid if the group send fails (e.g. the
      // leader already exited but a child lingers).
    }
    try {
      process.kill(pid, signal)
    } catch {
      // Ignore races if the process already exited.
    }
  }

  signalGroup('SIGTERM')

  const deadline = Date.now() + staleAppShutdownTimeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return
    }
    await wait(staleAppShutdownPollMs)
  }

  if (isPidAlive(pid)) {
    signalGroup('SIGKILL')
  }
}

const terminateStaleDevApps = async () => {
  if (process.platform === 'win32') {
    await terminateStaleWindowsDevApp()
    return
  }

  // Fast path: a clean restart writes the launched app's pid and clears it on
  // a clean exit, so a surviving pid file points straight at the stale tree.
  // Terminate just that pid tree and skip the full `ps -ax` image-path scan.
  // Only fall back to the scan when the pid file is absent — matching the
  // sibling runner's "unexpected absence means something leaked" heuristic.
  const recordedPid = readDevAppPid()
  if (recordedPid !== null) {
    if (recordedPid !== process.pid && isPidAlive(recordedPid)) {
      logError(
        `found stale dev Stella process (${recordedPid}); terminating tree before launch.`,
      )
      await terminateDarwinPidTree(recordedPid)
    }
    clearDevAppPid()
    return
  }

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

const consumeDevRestartRequest = () => {
  if (!existsSync(devRestartRequestFile)) {
    return false
  }

  try {
    rmSync(devRestartRequestFile, { force: true })
  } catch {
    // If cleanup races with process exit, the next restart cycle can consume it.
  }
  return true
}

const waitForDevRestartRequest = async () => {
  const deadline = Date.now() + devRestartRequestGraceMs
  while (!shuttingDown && Date.now() < deadline) {
    if (consumeDevRestartRequest()) {
      return true
    }
    await wait(100)
  }
  return false
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

  const useWindowsStartupFeedbackLauncher =
    process.platform === 'win32' && existsSync(windowsStartupFeedbackLauncher)
  const useDisclaim =
    !useWindowsStartupFeedbackLauncher && disclaimBinary && existsSync(disclaimBinary)
  const spawnCmd = useWindowsStartupFeedbackLauncher
    ? windowsStartupFeedbackLauncher
    : useDisclaim
      ? disclaimBinary
      : electronBinary
  const spawnArgs = useWindowsStartupFeedbackLauncher
    ? [electronBinary, '.']
    : useDisclaim
      ? [electronBinary, '.']
      : ['.']

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: repoRootDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      STELLA_DEV_RESTART_REQUEST_FILE: devRestartRequestFile,
      ...(process.env.STELLA_LAUNCHER_PROTECTED_STORAGE_BIN
        ? {}
        : { STELLA_DEV_INSECURE_PROTECTED_STORAGE: '1' }),
    },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsHide: true,
  })

  currentApp = child
  if (child.pid) {
    writeDevAppPid(child.pid)
  }

  child.once('error', () => {
    if (currentApp === child) {
      currentApp = null
    }

    if (!shuttingDown && restartRequestedByWatcher) {
      scheduleRestart()
    }
  })

  child.once('exit', async (code, signal) => {
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

    if (consumeDevRestartRequest()) {
      restartRequestedByWatcher = true
      scheduleRestart()
      return
    }

    if (await waitForDevRestartRequest()) {
      restartRequestedByWatcher = true
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
        await waitForBuildOutputsToSettle()
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
  clearDevAppPid()
  process.exit(exitCode)
}

await waitOn({
  resources: requiredFiles.map((filePath) => `file:${filePath}`),
  // wait-on defaults to a 750ms stability window (250ms poll) even once the
  // files already exist. Tighten it to a small buffer: window:100 still guards
  // against a half-written .vite-dev-url (which the later settle gate does not
  // re-validate) while shaving ~650ms off the common already-built case.
  window: 100,
  interval: 50,
})

await terminateStaleDevApps()

seedLastBuildHashes()
await waitForBuildOutputsToSettle()

watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!shouldRestartElectronForBuildPath(filename)) {
    return
  }

  // Content gate: only honor the watcher tick when the file's bytes
  // actually changed. Dev compilers can rewrite identical output as
  // a side effect of upstream watchers (tsconfig graph reaches into
  // node_modules, bunx mutates bun.lock, etc.). Restarting Electron
  // for those is the visible failure that kills self-mod morph
  // covers.
  const absPath = path.join(watchedDir, filename)
  const previousEntry = lastBuildHashes.has(absPath)
    ? lastBuildHashes.get(absPath)
    : undefined
  // Cheap stat pre-check: when size+mtime are byte-for-byte the same as the
  // last entry we recorded, the content is unchanged, so skip the multi-MB
  // re-read entirely (this is the redundant second read the first post-seed
  // tick used to pay). Only when stat differs do we fall back to hashing,
  // which still suppresses byte-identical rewrites that bump only mtime.
  if (
    previousEntry != null &&
    previousEntry.mtimeMs !== undefined &&
    previousEntry.size !== undefined
  ) {
    const currentStat = readBuildStat(absPath)
    if (
      currentStat &&
      currentStat.size === previousEntry.size &&
      currentStat.mtimeMs === previousEntry.mtimeMs
    ) {
      return
    }
  }
  const currentHash = readHash(absPath)
  const previousHash = previousEntry === undefined ? undefined : previousEntry?.hash ?? null
  if (previousHash !== undefined && currentHash === previousHash) {
    return
  }
  const currentStat = currentHash == null ? null : readBuildStat(absPath)
  lastBuildHashes.set(
    absPath,
    currentHash == null
      ? null
      : { hash: currentHash, size: currentStat?.size, mtimeMs: currentStat?.mtimeMs },
  )

  // Reaching here means the content gate confirmed a genuine byte change
  // (or a brand-new restart-relevant output). On a cold start the initial
  // esbuild watch emit is byte-identical to the seeded hash and never gets
  // this far, so a change inside the startup `watchReady` window means
  // Electron launched against stale artifacts (e.g. a warm restart where
  // dist-electron was not wiped) and the in-flight rebuild just produced
  // fresh bytes. Honor that immediately instead of swallowing it, otherwise
  // stale main/preload code keeps running with no auto-restart. We still arm
  // the watchReady timer to preserve its later role.
  if (!watchReady) {
    scheduleWatchReady()
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
