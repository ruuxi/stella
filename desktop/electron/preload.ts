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
  // Renderer acks that it has applied a particular chat context version. Used to avoid flashing stale frames on show.
  ackChatContext: (payload: { version: number }) => ipcRenderer.send('chatContext:ack', payload),
  onMiniVisibility: (callback: (visible: boolean) => void) => {
    const handler = (_event: IpcRendererEvent, data: { visible?: unknown }) => {
      callback(Boolean(data?.visible))
    }
    ipcRenderer.on('mini:visibility', handler)
    return () => {
      ipcRenderer.removeListener('mini:visibility', handler)
    }
  },
  onDismissPreview: (callback: () => void) => {
    ipcRenderer.on('mini:dismissPreview', callback)
    return () => {
      ipcRenderer.removeListener('mini:dismissPreview', callback)
    }
  },
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
    const handler = (
      event: IpcRendererEvent,
      data: { centerX: number; centerY: number; x?: number; y?: number }
    ) => {
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
  submitRegionClick: (point: { x: number; y: number }) =>
    ipcRenderer.send('region:click', point),
  cancelRegionCapture: () => ipcRenderer.send('region:cancel'),
  removeScreenshot: (index: number) => ipcRenderer.send('chatContext:removeScreenshot', index),

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
  collectAllSignals: (options?: { categories?: string[] }) =>
    ipcRenderer.invoke('signals:collectAll', options),

  // Identity map for pseudonymization
  getIdentityMap: () => ipcRenderer.invoke('identity:getMap'),
  depseudonymize: (text: string) => ipcRenderer.invoke('identity:depseudonymize', text),

  // System preferences (macOS FDA)
  openFullDiskAccess: () => ipcRenderer.send('system:openFullDiskAccess'),

  // Open URL in user's default browser
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),

  // Store package management
  storeInstallSkill: (payload: {
    packageId: string; skillId: string; name: string; markdown: string; agentTypes?: string[]; tags?: string[]
  }) => ipcRenderer.invoke('store:installSkill', payload),
  storeInstallTheme: (payload: {
    packageId: string; themeId: string; name: string; light: Record<string, string>; dark: Record<string, string>
  }) => ipcRenderer.invoke('store:installTheme', payload),
  storeInstallCanvas: (payload: {
    packageId: string; workspaceId?: string; name: string; dependencies?: Record<string, string>; source?: string
  }) => ipcRenderer.invoke('store:installCanvas', payload),
  storeInstallPlugin: (payload: {
    packageId: string; pluginId?: string; name?: string; version?: string; description?: string; manifest?: Record<string, unknown>; files?: Record<string, string>
  }) => ipcRenderer.invoke('store:installPlugin', payload),
  storeUninstall: (payload: {
    packageId: string; type: string; localId: string
  }) => ipcRenderer.invoke('store:uninstall', payload),

  // Theme loading from installed themes
  listInstalledThemes: () => ipcRenderer.invoke('theme:listInstalled'),

  // Canvas file reading — generated renderer reads source from ~/.stella/canvas/
  readCanvasFile: (filename: string) => ipcRenderer.invoke('canvas:readFile', filename),
  watchCanvasFile: (filename: string) => ipcRenderer.invoke('canvas:watchFile', filename),
  unwatchCanvasFile: (filename: string) => ipcRenderer.invoke('canvas:unwatchFile', filename),
  onCanvasFileChanged: (callback: (filename: string) => void) => {
    const handler = (_event: IpcRendererEvent, filename: string) => {
      callback(filename)
    }
    ipcRenderer.on('canvas:fileChanged', handler)
    return () => {
      ipcRenderer.removeListener('canvas:fileChanged', handler)
    }
  },
})
