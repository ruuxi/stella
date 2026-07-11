import { app, crashReporter, Menu } from 'electron'
import path from 'path'
import {
  AUTH_PROTOCOL,
  HARD_RESET_MUTABLE_HOME_PATHS,
  STARTUP_FIRST_PAINT_FALLBACK_MS,
  STARTUP_RUNTIME_WARMUP_DELAY_MS,
  STARTUP_STAGE_DELAY_MS,
  STELLA_APP_NAME,
  STELLA_SESSION_PARTITION,
  STELLA_WINDOWS_APP_USER_MODEL_ID,
} from './bootstrap/constants.js'
import { createBootstrapContext } from './bootstrap/context.js'
import { initMainProcessLogging } from './observability/main-logger.js'
import {
  getTotalSystemMemoryMb,
  isLowMemoryWindowsDevice,
} from './resource-profile.js'
import { resolveRuntimeStatePath } from '../../runtime/kernel/home/stella-home.js'
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from './bootstrap/lifecycle.js'
import { activateStagedStellaBrowserBinaryForInstall } from './utils/stella-browser-paths.js'
import { resolvePackagedPromptSiteUrl } from './prompt-site-config.js'
const __dirname = import.meta.dirname
const stellaAppDir = path.resolve(__dirname, '..', '..', '..', '..')
const stellaDataDirPath = resolveRuntimeStatePath(undefined, stellaAppDir)

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const useDevServer = isDev && process.env.STELLA_STATIC_PREVIEW !== '1'
const installDevBrokenPipeGuards = () => {
  if (!isDev) {
    return
  }

  const swallowBrokenPipe = (_error: Error & { code?: string }) => {
    // Dev-mode Electron inherits stdio from the runner process. If that parent
    // pipe disappears, logging should not crash the app.
  }

  process.stdout.on('error', swallowBrokenPipe)
  process.stderr.on('error', swallowBrokenPipe)
}

const configureDevUserDataPath = () => {
  if (!isDev) {
    return
  }

  const devUserDataPath = path.join(stellaDataDirPath, 'electron-user-data')
  app.setPath('userData', devUserDataPath)
  app.setPath('sessionData', path.join(devUserDataPath, 'session-data'))
}

const configureDevKeychainBehavior = () => {
  if (!isDev || process.platform !== 'darwin') {
    return
  }

  // Stella's protected secrets route exclusively through the launcher's
  // signed Tauri binary (see `runtime/kernel/shared/protected-storage.ts`),
  // so Stella itself does NOT call Electron's `safeStorage` API in this
  // configuration. The macOS Keychain prompt for "Electron Safe Storage"
  // would only appear if our code somehow reached `safeStorage`, which the
  // launcher-mode guard inside `getSafeStorage` now prevents. The Chromium
  // switches below are kept for cross-platform defense-in-depth: they stop
  // the cookie-encryption store from initializing a Keychain entry on
  // platforms where it would otherwise do so.
  app.commandLine.appendSwitch('use-mock-keychain')
  app.commandLine.appendSwitch('password-store', 'basic')
}

const configureDevRemoteDebugging = () => {
  if (!isDev) {
    return
  }
  const port = process.env.STELLA_REMOTE_DEBUG_PORT?.trim()
  if (!port || !/^\d+$/.test(port)) {
    return
  }
  // Harness hook: expose a Chromium remote-debugging endpoint so a background
  // agent can attach via CDP (stella-browser) and drive/observe this instance.
  // Off unless STELLA_REMOTE_DEBUG_PORT is set, so the primary dev install is
  // unaffected. Bind loopback-only and allow local CDP clients that send an
  // Origin header (some send `null`/localhost).
  app.commandLine.appendSwitch('remote-debugging-port', port)
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

const startLocalCrashReporter = () => {
  try {
    crashReporter.start({
      uploadToServer: false,
      compress: true,
      globalExtra: {
        app: 'stella',
      },
    })
  } catch {
    // Crash reporting is best-effort diagnostics only.
  }
}

export const bootstrapMainProcess = () => {
  app.setName(STELLA_APP_NAME)
  initMainProcessLogging(stellaAppDir)
  // Update completion normally promotes this artifact before recording the
  // release. Reconcile it again at the earliest startup point so an
  // interrupted update cannot leave HEAD=new / working-tree=old until the
  // browser native-host service happens to register.
  try {
    if (activateStagedStellaBrowserBinaryForInstall(stellaAppDir)) {
      console.log(
        '[updates] Activated staged Stella Browser binary during startup.',
      )
    }
  } catch (error) {
    console.error(
      '[updates] Could not activate staged Stella Browser binary during startup:',
      error,
    )
  }
  installDevBrokenPipeGuards()
  configureDevKeychainBehavior()
  configureDevRemoteDebugging()
  configureDevUserDataPath()
  startLocalCrashReporter()
  // Stella ships its own chrome (custom top bar, custom window controls on
  // Windows). Electron's default application menu otherwise renders an
  // in-window File/Edit/View/Window/Help bar on Windows/Linux directly below
  // the native title bar, doubling up with our top bar. Keep macOS' native
  // app menu so standard Edit roles continue to provide Cmd+C/Cmd+V/etc.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId(STELLA_WINDOWS_APP_USER_MODEL_ID)
  }
  if (isLowMemoryWindowsDevice()) {
    console.log(
      `[resource] Low-memory Windows profile enabled (${getTotalSystemMemoryMb()} MB total)`,
    )
  }

  const context = createBootstrapContext({
    authProtocol: AUTH_PROTOCOL,
    electronDir: __dirname,
    stellaAppDir,
    stellaDataDirPath,
    promptSiteUrl: resolvePackagedPromptSiteUrl(stellaAppDir),
    hardResetMutableHomePaths: HARD_RESET_MUTABLE_HOME_PATHS,
    isDev,
    useDevServer,
    sessionPartition: STELLA_SESSION_PARTITION,
    startupStageDelayMs: STARTUP_STAGE_DELAY_MS,
    startupFirstPaintFallbackMs: STARTUP_FIRST_PAINT_FALLBACK_MS,
    startupRuntimeWarmupDelayMs: STARTUP_RUNTIME_WARMUP_DELAY_MS,
  })

  if (!initializeBootstrapSingleInstance(context)) {
    return
  }

  registerBootstrapLifecycle(context)
}
