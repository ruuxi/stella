import { app, crashReporter } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  AUTH_PROTOCOL,
  HARD_RESET_MUTABLE_HOME_PATHS,
  STARTUP_STAGE_DELAY_MS,
  STELLA_APP_NAME,
  STELLA_SESSION_PARTITION,
  STELLA_WINDOWS_APP_USER_MODEL_ID,
} from './bootstrap/constants.js'
import { createBootstrapContext } from './bootstrap/context.js'
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from './bootstrap/lifecycle.js'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const stellaRoot = path.resolve(__dirname, '..', '..', '..', '..')

const isDev = process.env.NODE_ENV === 'development'
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

  const devUserDataPath = path.join(stellaRoot, 'state', 'electron-user-data')
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
  installDevBrokenPipeGuards()
  configureDevKeychainBehavior()
  configureDevUserDataPath()
  startLocalCrashReporter()
  if (process.platform === 'win32') {
    app.setAppUserModelId(STELLA_WINDOWS_APP_USER_MODEL_ID)
  }

  const context = createBootstrapContext({
    authProtocol: AUTH_PROTOCOL,
    electronDir: __dirname,
    stellaRoot,
    hardResetMutableHomePaths: HARD_RESET_MUTABLE_HOME_PATHS,
    isDev,
    sessionPartition: STELLA_SESSION_PARTITION,
    startupStageDelayMs: STARTUP_STAGE_DELAY_MS,
  })

  if (!initializeBootstrapSingleInstance(context)) {
    return
  }

  registerBootstrapLifecycle(context)
}
