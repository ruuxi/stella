import { globalShortcut, ipcMain } from 'electron'
import type { PiHostRunner } from '../../pi-host-runner.js'
import type { UiState } from '../../types.js'
import type { WindowManager } from '../../windows/window-manager.js'
import type { OverlayWindowController } from '../../windows/overlay-window.js'

type VoiceHandlersOptions = {
  uiState: UiState
  getAppReady: () => boolean
  windowManager: WindowManager
  broadcastUiState: () => void
  scheduleResumeWakeWord: () => void
  syncVoiceOverlay: () => void
  getPiHostRunner: () => PiHostRunner | null
  getOverlayController: () => OverlayWindowController | null
  getConvexSiteUrl: () => string | null
  getAuthToken: () => Promise<string | null> | string | null
  setAssistantSpeaking: (active: boolean) => Promise<void>
}

type VoiceRuntimeSnapshot = {
  sessionState: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnecting'
  isConnected: boolean
  isSpeaking: boolean
  isUserSpeaking: boolean
  micLevel: number
  outputLevel: number
}

const DEFAULT_RUNTIME_STATE: VoiceRuntimeSnapshot = {
  sessionState: 'idle',
  isConnected: false,
  isSpeaking: false,
  isUserSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
}

export const registerVoiceHandlers = (options: VoiceHandlersOptions) => {
  let currentVoiceShortcut = 'CommandOrControl+Shift+V'
  let currentVoiceRtcShortcut = 'CommandOrControl+Shift+D'
  let runtimeState: VoiceRuntimeSnapshot = DEFAULT_RUNTIME_STATE

  const broadcastRuntimeState = () => {
    for (const window of options.windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send('voice:runtimeState', runtimeState)
    }
  }

  const toggleVoice = () => {
    if (!options.getAppReady()) return
    options.uiState.isVoiceActive = !options.uiState.isVoiceActive
    if (options.uiState.isVoiceActive) {
      options.uiState.isVoiceRtcActive = false
      options.uiState.mode = 'voice'
    } else {
      options.scheduleResumeWakeWord()
    }
    options.syncVoiceOverlay()
    options.broadcastUiState()
  }

  const toggleVoiceRtc = () => {
    if (!options.getAppReady()) return
    options.uiState.isVoiceRtcActive = !options.uiState.isVoiceRtcActive
    if (options.uiState.isVoiceRtcActive) {
      options.uiState.isVoiceActive = false
      options.uiState.mode = 'voice'
    } else {
      options.scheduleResumeWakeWord()
    }
    options.syncVoiceOverlay()
    options.broadcastUiState()
  }

  globalShortcut.register(currentVoiceShortcut, toggleVoice)
  globalShortcut.register(currentVoiceRtcShortcut, toggleVoiceRtc)

  ipcMain.on('voice:setShortcut', (_event, shortcut: string) => {
    globalShortcut.unregister(currentVoiceShortcut)
    currentVoiceShortcut = shortcut
    if (shortcut) {
      globalShortcut.register(shortcut, toggleVoice)
    }
  })

  ipcMain.on('voice-rtc:setShortcut', (_event, shortcut: string) => {
    globalShortcut.unregister(currentVoiceRtcShortcut)
    currentVoiceRtcShortcut = shortcut
    if (shortcut) {
      globalShortcut.register(shortcut, toggleVoiceRtc)
    }
  })

  ipcMain.on('voice:transcript', (_event, transcript: string) => {
    console.log(`[${ts()}] [Voice] Transcript:`, transcript)
    const miniWindow = options.windowManager.getMiniWindow()
    const fullWindow = options.windowManager.getFullWindow()
    const preferredWindow = options.uiState.window === 'mini'
      ? (miniWindow ?? fullWindow)
      : (fullWindow ?? miniWindow)

    if (preferredWindow && !preferredWindow.isDestroyed()) {
      preferredWindow.webContents.send('voice:transcript', transcript)
    }
  })

  const ts = () => {
    const d = new Date()
    return `${d.toLocaleTimeString('en-US', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  }

  ipcMain.on('voice:persistTranscript', (_event, payload: {
    conversationId: string;
    role: 'user' | 'assistant';
    text: string;
  }) => {
    console.log(`[${ts()}] [Voice RTC] ${payload.role.toUpperCase()}: ${payload.text}`)
    const piHostRunner = options.getPiHostRunner()
    if (!piHostRunner) return
    try {
      piHostRunner.appendThreadMessage({
        conversationId: payload.conversationId,
        role: payload.role,
        content: payload.text,
      })
    } catch (err) {
      console.debug('[voice] transcript persistence failed (best-effort):', (err as Error).message)
    }
  })

  ipcMain.handle('voice:orchestratorChat', async (_event, payload: { conversationId: string; message: string }) => {
    console.log(`[${ts()}] [Voice] orchestratorChat request:`, payload.message)
    const piHostRunner = options.getPiHostRunner()
    if (!piHostRunner) {
      throw new Error('Pi runtime not initialized')
    }

    return new Promise<string>((resolve, reject) => {
      let fullText = ''
      piHostRunner.handleLocalChat(
        {
          conversationId: payload.conversationId,
          userMessageId: `voice-${Date.now()}`,
          userPrompt: payload.message,
          agentType: 'orchestrator',
          storageMode: 'local',
        },
        {
          onStream: (ev) => {
            if (ev.chunk) fullText += ev.chunk
          },
          onToolStart: () => {},
          onToolEnd: () => {},
          onSelfModHmrState: (state) => {
            const miniWindow = options.windowManager.getMiniWindow()
            const fullWindow = options.windowManager.getFullWindow()
            const targetWindow = options.uiState.window === 'mini'
              ? (miniWindow ?? fullWindow)
              : (fullWindow ?? miniWindow)
            if (targetWindow && !targetWindow.isDestroyed()) {
              targetWindow.webContents.send('agent:selfModHmrState', state)
            }
          },
          onEnd: (ev) => {
            const result = (ev.finalText ?? fullText) || 'Done.'
            console.log(`[${ts()}] [Voice] orchestratorChat result:`, result.slice(0, 300))
            resolve(result)
          },
          onError: (ev) => {
            console.error(`[${ts()}] [Voice] orchestratorChat error:`, ev.error)
            reject(new Error(ev.error ?? 'Unknown error'))
          },
        },
      ).catch((err) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  })

  ipcMain.handle('voice:setAssistantSpeaking', async (_event, active: boolean) => {
    await options.setAssistantSpeaking(Boolean(active))
    return { ok: true }
  })

  ipcMain.handle('voice:getRuntimeState', () => runtimeState)

  ipcMain.on('voice:runtimeState', (_event, nextState: VoiceRuntimeSnapshot) => {
    runtimeState = {
      sessionState: nextState?.sessionState ?? 'idle',
      isConnected: Boolean(nextState?.isConnected),
      isSpeaking: Boolean(nextState?.isSpeaking),
      isUserSpeaking: Boolean(nextState?.isUserSpeaking),
      micLevel: Number.isFinite(nextState?.micLevel) ? Math.max(0, Number(nextState.micLevel)) : 0,
      outputLevel: Number.isFinite(nextState?.outputLevel) ? Math.max(0, Number(nextState.outputLevel)) : 0,
    }
    broadcastRuntimeState()
  })
}
