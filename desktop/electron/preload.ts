import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  MiniBridgeRequest,
  MiniBridgeRequestEnvelope,
  MiniBridgeResponse,
  MiniBridgeResponseEnvelope,
  MiniBridgeUpdate,
} from './mini-bridge.js'

// ---------------------------------------------------------------------------
// IPC listener helpers — eliminate boilerplate for the 3 common patterns.
// ---------------------------------------------------------------------------

/** Subscribe to an IPC channel, stripping the IpcRendererEvent and forwarding data. */
const onIpc = <T>(channel: string) =>
  (callback: (data: T) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: T) => callback(data)
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  }

/** Subscribe to an IPC channel that sends no payload. */
const onIpcSignal = (channel: string) =>
  (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  }

/** Subscribe to an IPC channel, forwarding both the event and payload. */
const onIpcWithEvent = <T>(channel: string) =>
  (callback: (event: IpcRendererEvent, data: T) => void): (() => void) => {
    ipcRenderer.on(channel, callback)
    return () => { ipcRenderer.removeListener(channel, callback) }
  }

// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    show: (target: 'mini' | 'full') => ipcRenderer.send('window:show', target),
  },

  ui: {
    getState: () => ipcRenderer.invoke('ui:getState'),
    setState: (partial: Record<string, unknown>) => ipcRenderer.invoke('ui:setState', partial),
    onState: onIpc<Record<string, unknown>>('ui:state'),
    setAppReady: (ready: boolean) => ipcRenderer.send('app:setReady', ready),
    reload: () => ipcRenderer.send('app:reload'),
    hardReset: () => ipcRenderer.invoke('app:hardResetLocalState') as Promise<{ ok: boolean }>,
  },

  capture: {
    getContext: () => ipcRenderer.invoke('chatContext:get'),
    onContext: onIpc<Record<string, unknown> | null>('chatContext:updated'),
    ackContext: (payload: { version: number }) => ipcRenderer.send('chatContext:ack', payload),
    screenshot: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke('screenshot:capture', point),
    removeScreenshot: (index: number) => ipcRenderer.send('chatContext:removeScreenshot', index),
    submitRegionSelection: (payload: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('region:select', payload),
    submitRegionClick: (point: { x: number; y: number }) =>
      ipcRenderer.send('region:click', point),
    getWindowCapture: (point: { x: number; y: number }) =>
      ipcRenderer.invoke('region:getWindowCapture', point) as Promise<{
        bounds: { x: number; y: number; width: number; height: number };
        thumbnail: string;
      } | null>,
    cancelRegion: () => ipcRenderer.send('region:cancel'),
    pageDataUrl: () => ipcRenderer.invoke('capture:pageDataUrl') as Promise<string | null>,
    onRegionReset: onIpcSignal('region:reset'),
  },

  radial: {
    onShow: onIpcWithEvent<{ centerX: number; centerY: number; x?: number; y?: number }>('radial:show'),
    onHide: onIpcSignal('radial:hide'),
    animDone: () => ipcRenderer.send('radial:animDone'),
    onCursor: onIpcWithEvent<{ x: number; y: number; centerX: number; centerY: number }>('radial:cursor'),
  },

  overlay: {
    setInteractive: (interactive: boolean) =>
      ipcRenderer.send('overlay:setInteractive', interactive),
    onModifierBlock: onIpc<boolean>('overlay:modifierBlock'),
    onStartRegionCapture: onIpcSignal('overlay:startRegionCapture'),
    onEndRegionCapture: onIpcSignal('overlay:endRegionCapture'),
    onShowMini: onIpc<{ x: number; y: number }>('overlay:showMini'),
    onHideMini: onIpcSignal('overlay:hideMini'),
    onRestoreMini: onIpcSignal('overlay:restoreMini'),
    onShowVoice: onIpc<{ x: number; y: number; mode: 'stt' | 'realtime' }>('overlay:showVoice'),
    onHideVoice: onIpcSignal('overlay:hideVoice'),
    onDisplayChange: onIpc<{ origin: { x: number; y: number }; bounds: { x: number; y: number; width: number; height: number } }>('overlay:displayChange'),
    onMorphForward: onIpc<{ screenshotDataUrl: string; x: number; y: number; width: number; height: number }>('overlay:morphForward'),
    onMorphReverse: onIpc<{ screenshotDataUrl: string }>('overlay:morphReverse'),
    onMorphEnd: onIpcSignal('overlay:morphEnd'),
    morphDone: () => ipcRenderer.send('overlay:morphDone'),
  },

  mini: {
    onVisibility: (callback: (visible: boolean) => void) => {
      const handler = (_event: IpcRendererEvent, data: { visible?: boolean }) => {
        callback(Boolean(data?.visible))
      }
      ipcRenderer.on('mini:visibility', handler)
      return () => { ipcRenderer.removeListener('mini:visibility', handler) }
    },
    onDismissPreview: onIpcSignal('mini:dismissPreview'),
    request: (request: MiniBridgeRequest) =>
      ipcRenderer.invoke('miniBridge:request', request) as Promise<MiniBridgeResponse>,
    onUpdate: onIpc<MiniBridgeUpdate>('miniBridge:update'),
    onRequest: onIpc<MiniBridgeRequestEnvelope>('miniBridge:request'),
    respond: (envelope: MiniBridgeResponseEnvelope) => ipcRenderer.send('miniBridge:response', envelope),
    ready: () => ipcRenderer.send('miniBridge:ready'),
    pushUpdate: (update: MiniBridgeUpdate) => ipcRenderer.send('miniBridge:update', update),
  },

  theme: {
    onChange: onIpcWithEvent<{ key: string; value: string }>('theme:change'),
    broadcast: (key: string, value: string) => ipcRenderer.send('theme:broadcast', { key, value }),
    listInstalled: () => ipcRenderer.invoke('theme:listInstalled'),
  },

  voice: {
    submitTranscript: (transcript: string) => ipcRenderer.send('voice:transcript', transcript),
    setShortcut: (shortcut: string) => ipcRenderer.send('voice:setShortcut', shortcut),
    onTranscript: onIpc<string>('voice:transcript'),
    persistTranscript: (payload: { conversationId: string; role: 'user' | 'assistant'; text: string }) =>
      ipcRenderer.send('voice:persistTranscript', payload),
    orchestratorChat: (payload: { conversationId: string; message: string }) =>
      ipcRenderer.invoke('voice:orchestratorChat', payload) as Promise<string>,
    setRtcShortcut: (shortcut: string) => ipcRenderer.send('voice-rtc:setShortcut', shortcut),
    onRtcPreWarm: onIpc<string>('voice-rtc:pre-warm'),
    onRtcPrefetchToken: onIpcSignal('voice-rtc:prefetch-token'),
  },

  agent: {
    healthCheck: () => ipcRenderer.invoke('agent:healthCheck') as Promise<{ ready: true; runnerVersion: string } | null>,
    getActiveRun: () =>
      ipcRenderer.invoke('agent:getActiveRun') as Promise<{ runId: string; conversationId: string } | null>,
    startChat: (payload: {
      conversationId: string;
      userMessageId: string;
      userPrompt: string;
      agentType?: string;
      storageMode?: 'cloud' | 'local';
    }) => ipcRenderer.invoke('agent:startChat', payload) as Promise<{ runId: string }>,
    cancelChat: (runId: string) => ipcRenderer.send('agent:cancelChat', runId),
    resumeStream: (payload: { runId: string; lastSeq: number }) =>
      ipcRenderer.invoke('agent:resume', payload) as Promise<{
        events: Array<{
          type: 'stream' | 'tool-start' | 'tool-end' | 'error' | 'end';
          runId: string;
          seq: number;
          chunk?: string;
          toolCallId?: string;
          toolName?: string;
          resultPreview?: string;
          error?: string;
          fatal?: boolean;
          finalText?: string;
          persisted?: boolean;
          selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
        }>;
        exhausted: boolean;
      }>,
    onStream: onIpc<{
      type: 'stream' | 'tool-start' | 'tool-end' | 'error' | 'end';
      runId: string;
      seq: number;
      chunk?: string;
      toolCallId?: string;
      toolName?: string;
      resultPreview?: string;
      error?: string;
      fatal?: boolean;
      finalText?: string;
      persisted?: boolean;
      selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
    }>('agent:event'),
    onSelfModHmrState: onIpc<{ paused: boolean; message: string }>('agent:selfModHmrState'),
    selfModRevert: (featureId?: string, steps?: number) =>
      ipcRenderer.invoke('selfmod:revert', { featureId, steps }),
    getLastSelfModFeature: () =>
      ipcRenderer.invoke('selfmod:lastFeature'),
    listSelfModFeatures: (limit?: number) =>
      ipcRenderer.invoke('selfmod:recentFeatures', { limit }) as Promise<Array<{
        featureId: string;
        name: string;
        description: string;
        latestCommit: string;
        latestTimestampMs: number;
        commitCount: number;
        tainted?: boolean;
        taintedFiles?: string[];
      }>>,
    triggerViteError: () => ipcRenderer.invoke('devtest:triggerViteError'),
    fixViteError: () => ipcRenderer.invoke('devtest:fixViteError'),
  },

  system: {
    getDeviceId: () => ipcRenderer.invoke('device:getId'),
    configurePiRuntime: (config: { convexUrl?: string; convexSiteUrl?: string }) =>
      ipcRenderer.invoke('host:configurePiRuntime', config),
    setAuthState: (payload: { authenticated: boolean; token?: string }) => ipcRenderer.invoke('auth:setState', payload),
    setCloudSyncEnabled: (payload: { enabled: boolean }) => ipcRenderer.invoke('host:setCloudSyncEnabled', payload),
    onAuthCallback: onIpc<{ url: string }>('auth:callback'),
    openFullDiskAccess: () => ipcRenderer.send('system:openFullDiskAccess'),
    openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
    shellKillByPort: (port: number) => ipcRenderer.invoke('shell:killByPort', { port }),
    getLocalSyncMode: () => ipcRenderer.invoke('preferences:getSyncMode') as Promise<string>,
    setLocalSyncMode: (mode: string) => ipcRenderer.invoke('preferences:setSyncMode', mode),
    onCredentialRequest: onIpcWithEvent<{ requestId: string; provider: string; label?: string; description?: string; placeholder?: string }>('credential:request'),
    submitCredential: (payload: { requestId: string; secretId: string; provider: string; label: string }) =>
      ipcRenderer.invoke('credential:submit', payload),
    cancelCredential: (payload: { requestId: string }) =>
      ipcRenderer.invoke('credential:cancel', payload),
    getIdentityMap: () => ipcRenderer.invoke('identity:getMap'),
    depseudonymize: (text: string) => ipcRenderer.invoke('identity:depseudonymize', text),
    bridgeDeploy: (payload: {
      provider: string; code: string; env: Record<string, string>; dependencies: string
    }) => ipcRenderer.invoke('bridge:deploy', payload),
    bridgeStart: (payload: { provider: string }) => ipcRenderer.invoke('bridge:start', payload),
    bridgeStop: (payload: { provider: string }) => ipcRenderer.invoke('bridge:stop', payload),
    bridgeStatus: (payload: { provider: string }) => ipcRenderer.invoke('bridge:status', payload),
  },

  browser: {
    checkCoreMemoryExists: () => ipcRenderer.invoke('browserData:exists'),
    collectData: () => ipcRenderer.invoke('browserData:collect'),
    detectPreferred: () => ipcRenderer.invoke('browserData:detectPreferredBrowser'),
    listProfiles: (browserType: string) => ipcRenderer.invoke('browserData:listProfiles', browserType),
    writeCoreMemory: (content: string) => ipcRenderer.invoke('browserData:writeCoreMemory', content),
    collectAllSignals: (options?: { categories?: string[] }) =>
      ipcRenderer.invoke('signals:collectAll', options),
    listWorkspacePanels: () =>
      ipcRenderer.invoke('workspace:listPanels') as Promise<Array<{ name: string; title: string }>>,
    onWorkspacePanelsChanged: onIpc<Array<{ name: string; title: string }>>('workspace:panelsChanged'),
  },
})
