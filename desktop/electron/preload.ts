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
  getDeviceId: () => ipcRenderer.invoke('device:getId'),
  configureHost: (config: { convexUrl?: string }) => ipcRenderer.invoke('host:configure', config),

  // Radial dial events
  onRadialShow: (callback: (event: IpcRendererEvent, data: { centerX: number; centerY: number }) => void) => {
    const handler = (event: IpcRendererEvent, data: { centerX: number; centerY: number }) => {
      callback(event, data)
    }
    ipcRenderer.on('radial:show', handler)
    return () => {
      ipcRenderer.removeListener('radial:show', handler)
    }
  },
  onRadialHide: (callback: () => void) => {
    const handler = () => {
      callback()
    }
    ipcRenderer.on('radial:hide', handler)
    return () => {
      ipcRenderer.removeListener('radial:hide', handler)
    }
  },
  onRadialCursor: (
    callback: (event: IpcRendererEvent, data: { x: number; y: number; centerX: number; centerY: number }) => void
  ) => {
    const handler = (event: IpcRendererEvent, data: { x: number; y: number; centerX: number; centerY: number }) => {
      callback(event, data)
    }
    ipcRenderer.on('radial:cursor', handler)
    return () => {
      ipcRenderer.removeListener('radial:cursor', handler)
    }
  },
  onRadialMouseUp: (callback: (event: IpcRendererEvent, data: { wedge: string | null }) => void) => {
    const handler = (event: IpcRendererEvent, data: { wedge: string | null }) => {
      callback(event, data)
    }
    ipcRenderer.on('radial:mouseup', handler)
    return () => {
      ipcRenderer.removeListener('radial:mouseup', handler)
    }
  },
  radialSelect: (wedge: string) => ipcRenderer.send('radial:select', wedge),
})
