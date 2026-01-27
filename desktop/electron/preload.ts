import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  getUiState: () => ipcRenderer.invoke('ui:getState'),
  setUiState: (partial: unknown) => ipcRenderer.invoke('ui:setState', partial),
  onUiState: (callback: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => {
      callback(state)
    }
    ipcRenderer.on('ui:state', handler)
    return () => {
      ipcRenderer.removeListener('ui:state', handler)
    }
  },
  showWindow: (target: 'mini' | 'full') => ipcRenderer.send('window:show', target),
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
})
