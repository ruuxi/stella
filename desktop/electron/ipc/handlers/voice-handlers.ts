import { globalShortcut, ipcMain } from 'electron'
import type { StellaHostRunner } from '../../stella-host-runner.js'
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
  getStellaHostRunner: () => StellaHostRunner | null
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
    const stellaHostRunner = options.getStellaHostRunner()
    if (!stellaHostRunner) return
    try {
      stellaHostRunner.appendThreadMessage({
        conversationId: payload.conversationId,
        role: payload.role,
        content: payload.text,
      })
    } catch (err) {
      console.debug('[voice] transcript persistence failed (best-effort):', (err as Error).message)
    }
  })

  // Queue for voice requests while the orchestrator is busy.
  // Only the latest pending request is kept — if the user refines their ask
  // while the orchestrator is running, earlier queued requests are dropped.
  type PendingVoiceRequest = {
    payload: { conversationId: string; message: string }
    resolve: (value: string) => void
    reject: (error: Error) => void
  }
  let pendingVoiceRequest: PendingVoiceRequest | null = null
  let voiceRequestActive = false

  const executeVoiceChat = (
    payload: { conversationId: string; message: string },
    stellaHostRunner: StellaHostRunner,
  ): Promise<string> => {
    console.log(`[${ts()}] [Voice] orchestratorChat executing:`, payload.message)

    // Emit agent events to the full window so the trace viewer can capture them
    const emitToFrontend = (eventPayload: Record<string, unknown>) => {
      const fullWindow = options.windowManager.getFullWindow()
      if (fullWindow && !fullWindow.isDestroyed()) {
        fullWindow.webContents.send('agent:event', eventPayload)
      }
    }

    return new Promise<string>((resolve, reject) => {
      let fullText = ''
      stellaHostRunner.handleLocalChat(
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
          onToolStart: (ev) => {
            emitToFrontend({ type: 'tool-start', ...ev })
          },
          onToolEnd: (ev) => {
            emitToFrontend({ type: 'tool-end', ...ev })
          },
          onTaskEvent: (ev) => {
            emitToFrontend({
              type: ev.type,
              runId: 'voice',
              seq: Date.now(),
              taskId: ev.taskId,
              agentType: ev.agentType,
              description: ev.description,
              parentTaskId: ev.parentTaskId,
              result: ev.result,
              error: ev.error,
              statusText: ev.statusText,
            })
          },
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
            emitToFrontend({ type: 'end', ...ev })
            resolve(result)
          },
          onError: (ev) => {
            console.error(`[${ts()}] [Voice] orchestratorChat error:`, ev.error)
            emitToFrontend({ type: 'error', ...ev })
            reject(new Error(ev.error ?? 'Unknown error'))
          },
        },
      ).catch((err) => {
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  const drainVoiceQueue = () => {
    const pending = pendingVoiceRequest
    pendingVoiceRequest = null
    if (!pending) {
      voiceRequestActive = false
      return
    }

    const stellaHostRunner = options.getStellaHostRunner()
    if (!stellaHostRunner) {
      pending.reject(new Error('Stella runtime not initialized'))
      voiceRequestActive = false
      return
    }

    console.log(`[${ts()}] [Voice] dequeuing pending request:`, pending.payload.message)
    executeVoiceChat(pending.payload, stellaHostRunner).then(
      (result) => {
        pending.resolve(result)
        drainVoiceQueue()
      },
      (err) => {
        pending.reject(err instanceof Error ? err : new Error(String(err)))
        drainVoiceQueue()
      },
    )
  }

  ipcMain.handle('voice:orchestratorChat', async (_event, payload: { conversationId: string; message: string }) => {
    console.log(`[${ts()}] [Voice] orchestratorChat request:`, payload.message)
    const stellaHostRunner = options.getStellaHostRunner()
    if (!stellaHostRunner) {
      throw new Error('Stella runtime not initialized')
    }

    // If the orchestrator is busy, queue this request and return a promise
    // that resolves when it eventually runs
    if (voiceRequestActive) {
      // Drop any previously queued request — only the latest matters
      if (pendingVoiceRequest) {
        console.log(`[${ts()}] [Voice] replacing queued request:`, pendingVoiceRequest.payload.message)
        pendingVoiceRequest.reject(new Error('Superseded by newer voice request'))
      }
      console.log(`[${ts()}] [Voice] orchestrator busy, queuing request:`, payload.message)
      return new Promise<string>((resolve, reject) => {
        pendingVoiceRequest = { payload, resolve, reject }
      })
    }

    voiceRequestActive = true
    try {
      const result = await executeVoiceChat(payload, stellaHostRunner)
      return result
    } finally {
      drainVoiceQueue()
    }
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
