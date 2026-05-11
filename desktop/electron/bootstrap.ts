import { app, crashReporter, safeStorage } from 'electron'
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

  // Stella in production runs as a dev-mode build (launcher unpacks the
  // repo and runs `bun run electron:dev`). The bundle identity is renamed
  // and patched at startup -- macOS's Keychain ACL is bound to the original
  // bundle signature, so any Keychain access from Electron triggers the
  // "Stella wants to use 'Electron Safe Storage'" prompt every time.
  //
  // We don't use Electron's `safeStorage` for protected secrets here -- those
  // route through the launcher's properly-signed Tauri binary or fall back
  // to dev-plaintext (`runtime/kernel/shared/protected-storage.ts`). But
  // Chromium itself eagerly fetches the OSCrypt encryption key on startup
  // for cookie encryption, and that key lives under "Electron Safe Storage"
  // in Keychain. `--use-mock-keychain` only stubs the password-manager path,
  // not OSCrypt. `--password-store=basic` is the documented switch that
  // tells Chromium to use a file-derived key instead of the Keychain.
  app.commandLine.appendSwitch('use-mock-keychain')
  app.commandLine.appendSwitch('password-store', 'basic')

  // Defensive belt-and-suspenders: even though our `protected-storage.ts`
  // routes around `safeStorage` in this configuration, a stray call (from
  // a future dependency or an upstream Electron change) would otherwise
  // touch the real Keychain. `setUsePlainTextEncryption` forces safeStorage
  // to use a base64-only path with no Keychain access, regardless of caller.
  app.whenReady().then(() => {
    try {
      safeStorage.setUsePlainTextEncryption(true)
    } catch {
      // Older Electron builds without the API, or already-initialized
      // safeStorage -- the basic password-store switch above is the
      // primary suppression.
    }
  })
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
