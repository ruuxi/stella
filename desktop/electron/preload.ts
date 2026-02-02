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
  captureScreenshot: (point?: { x: number; y: number }) =>
    ipcRenderer.invoke('screenshot:capture', point),
  getChatContext: () => ipcRenderer.invoke('chatContext:get'),
  onChatContext: (callback: (context: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, context: unknown) => {
      callback(context)
    }
    ipcRenderer.on('chatContext:updated', handler)
    return () => {
      ipcRenderer.removeListener('chatContext:updated', handler)
    }
  },
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

  // App readiness gate (controls radial menu + mini shell)
  setAppReady: (ready: boolean) => ipcRenderer.send('app:setReady', ready),

  // Radial dial events
  onRadialShow: (
    callback: (
      event: IpcRendererEvent,
      data: { centerX: number; centerY: number; x?: number; y?: number }
    ) => void
  ) => {
    const handler = (event: IpcRendererEvent, data: { centerX: number; centerY: number; x?: number; y?: number }) => {
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
  submitRegionSelection: (payload: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('region:select', payload),
  cancelRegionCapture: () => ipcRenderer.send('region:cancel'),

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

  // Browser data collection for core memory
  checkCoreMemoryExists: () => ipcRenderer.invoke('browserData:exists'),
  collectBrowserData: () => ipcRenderer.invoke('browserData:collect'),
  writeCoreMemory: (content: string) => ipcRenderer.invoke('browserData:writeCoreMemory', content),

  // Comprehensive user signal collection (browser + dev projects + shell + apps)
  collectAllSignals: () => ipcRenderer.invoke('signals:collectAll'),
})
