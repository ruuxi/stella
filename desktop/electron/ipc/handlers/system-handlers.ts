import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { getSyncMode, loadLocalPreferences, saveLocalPreferences } from '../../pi-runtime/extensions/stella/local-preferences.js'
import type { PiHostRunner } from '../../pi-host-runner.js'
import type { AuthService } from '../../services/auth-service.js'
import type { ExternalLinkService } from '../../services/external-link-service.js'

type SystemHandlersOptions = {
  getDeviceId: () => string | null
  authService: AuthService
  getPiHostRunner: () => PiHostRunner | null
  getStellaHomePath: () => string | null
  externalLinkService: ExternalLinkService
  ensurePrivilegedActionApproval: (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => Promise<boolean>
  hardResetLocalState: () => Promise<{ ok: true }>
  submitCredential: (payload: { requestId: string; secretId: string; provider: string; label: string }) => { ok: boolean; error?: string }
  cancelCredential: (payload: { requestId: string }) => { ok: boolean; error?: string }
}

const asTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const sanitizeOptionalHttpUrl = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value)
  if (!normalized) {
    return undefined
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`Invalid ${fieldName}.`)
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid ${fieldName}.`)
  }

  return parsed.toString()
}

export const registerSystemHandlers = (options: SystemHandlersOptions) => {
  ipcMain.handle('device:getId', () => options.getDeviceId())

  ipcMain.handle('host:configurePiRuntime', (event, config: { convexUrl?: string; convexSiteUrl?: string }) => {
    if (!options.externalLinkService.assertPrivilegedSender(event, 'host:configurePiRuntime')) {
      throw new Error('Blocked untrusted host configuration request.')
    }
    const convexUrl = sanitizeOptionalHttpUrl(config?.convexUrl, 'convexUrl')
    const convexSiteUrl = sanitizeOptionalHttpUrl(config?.convexSiteUrl, 'convexSiteUrl')
    if (convexUrl) {
      options.authService.configurePiRuntime({
        convexUrl,
        convexSiteUrl,
      })
    }
    return { deviceId: options.getDeviceId() }
  })

  ipcMain.handle('auth:setState', (event, payload: { authenticated?: boolean; token?: string }) => {
    if (!options.externalLinkService.assertPrivilegedSender(event, 'auth:setState')) {
      throw new Error('Blocked untrusted auth:setState request.')
    }
    options.authService.setHostAuthState(Boolean(payload?.authenticated), payload?.token)
    return { ok: true }
  })

  ipcMain.handle('host:setCloudSyncEnabled', (_event, payload: { enabled: boolean }) => {
    options.getPiHostRunner()?.setCloudSyncEnabled(Boolean(payload?.enabled))
    return { ok: true }
  })

  ipcMain.handle('app:hardResetLocalState', async () => {
    return options.hardResetLocalState()
  })

  ipcMain.handle('credential:submit', (_event, payload: { requestId: string; secretId: string; provider: string; label: string }) => {
    return options.submitCredential(payload)
  })

  ipcMain.handle('credential:cancel', (_event, payload: { requestId: string }) => {
    return options.cancelCredential(payload)
  })

  ipcMain.on('shell:openExternal', (event, url: string) => {
    if (!options.externalLinkService.assertPrivilegedSender(event, 'shell:openExternal')) {
      console.debug('[system] blocked untrusted shell:openExternal')
      return
    }
    const safeUrl = options.externalLinkService.normalizeExternalHttpUrl(url)
    if (!safeUrl) {
      console.debug('[system] rejected invalid URL for shell:openExternal')
      return
    }
    if (!options.externalLinkService.consumeExternalOpenBudget(event.sender.id)) {
      console.debug('[system] shell:openExternal rate limited')
      return
    }
    void shell.openExternal(safeUrl)
  })

  ipcMain.on('system:openFullDiskAccess', async (event) => {
    if (!options.externalLinkService.assertPrivilegedSender(event, 'system:openFullDiskAccess')) {
      return
    }
    const approved = await options.ensurePrivilegedActionApproval(
      'system.open_full_disk_access',
      'Allow Stella to open Full Disk Access settings?',
      'This opens macOS System Settings so Stella can be granted disk access for user-requested tasks.',
      event,
    )
    if (!approved) {
      return
    }
    if (process.platform === 'darwin') {
      import('child_process').then(({ exec: execCmd }) => {
        execCmd('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')
      })
    }
  })

  ipcMain.handle('shell:killByPort', async (event, payload: { port: number }) => {
    if (!options.externalLinkService.assertPrivilegedSender(event, 'shell:killByPort')) {
      throw new Error('Blocked untrusted shell kill request.')
    }
    const port = Number(payload?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid port.')
    }
    options.getPiHostRunner()?.killShellsByPort(port)
  })

  ipcMain.handle('preferences:getSyncMode', () => {
    const stellaHomePath = options.getStellaHomePath()
    if (!stellaHomePath) return 'on'
    return getSyncMode(stellaHomePath)
  })

  ipcMain.handle('preferences:setSyncMode', (_event, mode: string) => {
    const stellaHomePath = options.getStellaHomePath()
    if (!stellaHomePath) return
    const prefs = loadLocalPreferences(stellaHomePath)
    prefs.syncMode = mode === 'off' ? 'off' : 'on'
    saveLocalPreferences(stellaHomePath, prefs)
  })
}
