import { globalShortcut, ipcMain } from 'electron'
import type { PiHostRunner } from '../../pi-host-runner.js'
import type { UiState } from '../../types.js'
import type { WindowManager } from '../../windows/window-manager.js'

type VoiceHandlersOptions = {
  uiState: UiState
  getAppReady: () => boolean
  windowManager: WindowManager
  broadcastUiState: () => void
  scheduleResumeWakeWord: () => void
  syncVoiceOverlay: () => void
  getPiHostRunner: () => PiHostRunner | null
}

export const registerVoiceHandlers = (options: VoiceHandlersOptions) => {
  let currentVoiceShortcut = 'CommandOrControl+Shift+V'
  let currentVoiceRtcShortcut = 'CommandOrControl+Shift+D'

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
    const miniWindow = options.windowManager.getMiniWindow()
    const fullWindow = options.windowManager.getFullWindow()
    const preferredWindow = options.uiState.window === 'mini'
      ? (miniWindow ?? fullWindow)
      : (fullWindow ?? miniWindow)

    if (preferredWindow && !preferredWindow.isDestroyed()) {
      preferredWindow.webContents.send('voice:transcript', transcript)
    }
  })

  ipcMain.on('voice:persistTranscript', (_event, payload: {
    conversationId: string;
    role: 'user' | 'assistant';
    text: string;
  }) => {
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
            resolve((ev.finalText ?? fullText) || 'Done.')
          },
          onError: (ev) => {
            reject(new Error(ev.error ?? 'Unknown error'))
          },
        },
      ).catch((err) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  })
}
