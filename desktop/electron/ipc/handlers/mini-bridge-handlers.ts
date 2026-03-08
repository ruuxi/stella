import { BrowserWindow, ipcMain } from 'electron'
import type {
  MiniBridgeRequest,
  MiniBridgeResponseEnvelope,
  MiniBridgeUpdate,
} from '../../../src/shared/contracts/electron-data.js'
import type { MiniBridgeService } from '../../services/mini-bridge-service.js'
import type { WindowManager } from '../../windows/window-manager.js'

type MiniBridgeHandlersOptions = {
  miniBridgeService: MiniBridgeService
  windowManager: WindowManager
}

export const registerMiniBridgeHandlers = (options: MiniBridgeHandlersOptions) => {
  ipcMain.handle('miniBridge:request', async (event, request: MiniBridgeRequest) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    return options.miniBridgeService.requestFromMini(
      senderWindow,
      options.windowManager.getMiniWindow(),
      options.windowManager.getFullWindow(),
      request,
    )
  })

  ipcMain.on('miniBridge:ready', (event) => {
    options.miniBridgeService.handleReadySignal(
      BrowserWindow.fromWebContents(event.sender),
      options.windowManager.getFullWindow(),
    )
  })

  ipcMain.on('miniBridge:response', (event, envelope: MiniBridgeResponseEnvelope) => {
    options.miniBridgeService.handleResponseSignal(
      BrowserWindow.fromWebContents(event.sender),
      options.windowManager.getFullWindow(),
      envelope,
    )
  })

  ipcMain.on('miniBridge:update', (event, update: MiniBridgeUpdate) => {
    options.miniBridgeService.handleUpdateSignal(
      BrowserWindow.fromWebContents(event.sender),
      options.windowManager.getFullWindow(),
      options.windowManager.getMiniWindow(),
      update,
    )
  })
}
