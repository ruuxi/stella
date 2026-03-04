import { promises as fs } from 'fs'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import os from 'os'
import path from 'path'
import * as bridgeManager from '../../system/bridge-manager.js'

type StoreHandlersOptions = {
  assertPrivilegedSender: (event: IpcMainEvent | IpcMainInvokeEvent, channel: string) => boolean
  ensurePrivilegedActionApproval: (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => Promise<boolean>
}

export const registerStoreHandlers = (options: StoreHandlersOptions) => {
  ipcMain.handle('bridge:deploy', async (event, payload: {
    provider: string; code: string; env: Record<string, string>; dependencies: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:deploy')) {
      throw new Error('Blocked untrusted bridge deploy request.')
    }
    const approved = await options.ensurePrivilegedActionApproval(
      'bridge.deploy',
      'Allow Stella to deploy local bridge code?',
      'Bridge deploy writes executable code under ~/.stella/bridges and may install dependencies.',
      event,
    )
    if (!approved) {
      throw new Error('Bridge deploy denied.')
    }
    return bridgeManager.deploy(payload)
  })

  ipcMain.handle('bridge:start', async (event, payload: { provider: string }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:start')) {
      throw new Error('Blocked untrusted bridge start request.')
    }
    const approved = await options.ensurePrivilegedActionApproval(
      'bridge.start',
      'Allow Stella to start local bridge processes?',
      'Starting a bridge runs local Node.js code with configured bridge environment variables.',
      event,
    )
    if (!approved) {
      throw new Error('Bridge start denied.')
    }
    return bridgeManager.start(payload.provider)
  })

  ipcMain.handle('bridge:stop', async (event, payload: { provider: string }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:stop')) {
      throw new Error('Blocked untrusted bridge stop request.')
    }
    return bridgeManager.stop(payload.provider)
  })

  ipcMain.handle('bridge:status', async (event, payload: { provider: string }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:status')) {
      throw new Error('Blocked untrusted bridge status request.')
    }
    return { running: bridgeManager.isRunning(payload.provider) }
  })

  ipcMain.handle('theme:listInstalled', async () => {
    const themesDir = path.join(os.homedir(), '.stella', 'themes')
    try {
      const files = await fs.readdir(themesDir)
      const themes = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(themesDir, file), 'utf-8')
          const theme = JSON.parse(raw)
          if (theme.id && theme.name && theme.light && theme.dark) {
            themes.push(theme)
          }
        } catch {
          // skip invalid theme files
        }
      }
      return themes
    } catch {
      return []
    }
  })
}
