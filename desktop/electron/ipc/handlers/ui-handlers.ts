import { BrowserWindow, ipcMain } from 'electron'
import type { UiState } from '../../types.js'
import type { WindowManager } from '../../windows/window-manager.js'

type UiHandlersOptions = {
  uiState: UiState
  windowManager: WindowManager
  updateUiState: (partial: Partial<UiState>) => void
  broadcastUiState: () => void
  setAppReady: (ready: boolean) => void
  getResumeWakeWordCapture: () => (() => void) | null
  scheduleResumeWakeWord: () => void
  deactivateVoiceModes: () => boolean
}

export const registerUiHandlers = (options: UiHandlersOptions) => {
  ipcMain.on('app:setReady', (_event, ready: boolean) => {
    options.setAppReady(!!ready)
  })

  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    if (win === options.windowManager.getMiniWindow()) {
      options.deactivateVoiceModes()
      options.windowManager.hideMiniWindow(true)
      return
    }

    win.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })

  ipcMain.handle('ui:getState', () => options.uiState)

  ipcMain.handle('ui:setState', (_event, partial: Partial<UiState>) => {
    const { window: nextWindow, isVoiceActive, isVoiceRtcActive, ...rest } = partial
    if (nextWindow === 'mini' || nextWindow === 'full') {
      options.windowManager.showWindow(nextWindow)
    }
    if (isVoiceActive !== undefined) {
      options.uiState.isVoiceActive = isVoiceActive
    }
    if (isVoiceRtcActive !== undefined) {
      options.uiState.isVoiceRtcActive = isVoiceRtcActive
    }
    if (Object.keys(rest).length > 0) {
      options.updateUiState(rest)
    }
    if (isVoiceActive !== undefined || isVoiceRtcActive !== undefined) {
      options.broadcastUiState()
      if (
        (isVoiceActive === false || isVoiceRtcActive === false) &&
        options.getResumeWakeWordCapture()
      ) {
        options.scheduleResumeWakeWord()
      }
    }
    return options.uiState
  })

  ipcMain.on('window:show', (_event, target: 'full' | 'mini') => {
    if (target !== 'mini' && target !== 'full') {
      return
    }
    options.windowManager.showWindow(target)
  })

  ipcMain.on('theme:broadcast', (event, data: { key: string; value: string }) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    for (const window of options.windowManager.getAllWindows()) {
      if (window !== sender) {
        window.webContents.send('theme:change', data)
      }
    }
  })

  ipcMain.on('app:reload', () => {
    options.windowManager.reloadFullWindow()
  })
}
