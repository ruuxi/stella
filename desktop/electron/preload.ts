import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  
  // Window controls for custom title bar
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  
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
  setAuthToken: (payload: { token: string | null }) => ipcRenderer.invoke('auth:setToken', payload),
  onAuthCallback: (callback: (data: { url: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { url: string }) => {
      callback(data)
    }
    ipcRenderer.on('auth:callback', handler)
    return () => {
      ipcRenderer.removeListener('auth:callback', handler)
    }
  },

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

  // Theme sync across windows
  onThemeChange: (callback: (event: IpcRendererEvent, data: { key: string; value: string }) => void) => {
    const handler = (event: IpcRendererEvent, data: { key: string; value: string }) => {
      callback(event, data)
    }
    ipcRenderer.on('theme:change', handler)
    return () => {
      ipcRenderer.removeListener('theme:change', handler)
    }
  },
  broadcastThemeChange: (key: string, value: string) => ipcRenderer.send('theme:broadcast', { key, value }),

  onCredentialRequest: (
    callback: (event: IpcRendererEvent, data: { requestId: string; provider: string; label?: string; description?: string; placeholder?: string }) => void,
  ) => {
    const handler = (
      event: IpcRendererEvent,
      data: { requestId: string; provider: string; label?: string; description?: string; placeholder?: string },
    ) => {
      callback(event, data)
    }
    ipcRenderer.on('credential:request', handler)
    return () => {
      ipcRenderer.removeListener('credential:request', handler)
    }
  },
  submitCredential: (payload: { requestId: string; secretId: string; provider: string; label: string }) =>
    ipcRenderer.invoke('credential:submit', payload),
  cancelCredential: (payload: { requestId: string }) =>
    ipcRenderer.invoke('credential:cancel', payload),
})
