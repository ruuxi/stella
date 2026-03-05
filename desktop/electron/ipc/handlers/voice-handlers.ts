import { globalShortcut, ipcMain } from 'electron'
import type { PiHostRunner } from '../../pi-host-runner.js'
import type { UiState } from '../../types.js'
import type { WindowManager } from '../../windows/window-manager.js'
import type { OverlayWindowController } from '../../windows/overlay-window.js'

type MercuryToolResult = {
  action: string
  spoken_summary?: string
  query?: string
  results?: Array<{ title: string; url: string; snippet: string }>
  title?: string
  html?: string
  operation?: string
  window_type?: string
}

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

  // ─── Neri Window State Cache ──────────────────────────────────────────

  let cachedNeriWindowState: Array<{ type: string; title: string }> = []

  ipcMain.on('neri:windowState', (_event, state: Array<{ type: string; title: string }>) => {
    cachedNeriWindowState = state
  })

  // ─── Mercury Chat ─────────────────────────────────────────────────────

  ipcMain.handle('voice:mercuryChat', async (_event, payload: { conversationId: string; message: string }) => {
    console.log(`[${ts()}] [Mercury] Request:`, payload.message)
    const rawSiteUrl = options.getConvexSiteUrl()
    const authToken = await Promise.resolve(options.getAuthToken())

    if (!rawSiteUrl) {
      throw new Error('Convex site URL not configured')
    }

    const convexSiteUrl = rawSiteUrl.replace(/\/+$/, '')
    console.log(`[${ts()}] [Mercury] Endpoint:`, `${convexSiteUrl}/api/mercury/chat`)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`
      }

      const response = await fetch(`${convexSiteUrl}/api/mercury/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: payload.message,
          conversationId: payload.conversationId,
          windowState: { windows: cachedNeriWindowState },
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Mercury returned ${response.status}: ${text}`)
      }

      const data = await response.json() as {
        toolResults: MercuryToolResult[]
        text: string | null
      }

      // Process tool results — dispatch UI commands to overlay
      console.log(`[${ts()}] [Mercury] Tool results:`, JSON.stringify(data.toolResults.map(tr => ({ action: tr.action, spoken_summary: tr.spoken_summary }))))
      const overlayController = options.getOverlayController()
      const spokenParts: string[] = []

      for (const tr of data.toolResults) {
        if (tr.spoken_summary) {
          spokenParts.push(tr.spoken_summary)
        }

        switch (tr.action) {
          case 'show_search':
            console.log(`[${ts()}] [Mercury → Neri] Opening search window: ${tr.query} (${(tr.results ?? []).length} results)`)
            if (overlayController) {
              overlayController.showNeri()
              const overlayWindow = overlayController.getWindow()
              if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('neri:openSearchWindow', {
                  query: tr.query ?? '',
                  results: tr.results ?? [],
                })
              }
            }
            break

          case 'open_dashboard':
            console.log(`[${ts()}] [Mercury → Neri] Opening dashboard`)
            overlayController?.showNeri()
            break

          case 'close_dashboard':
            console.log(`[${ts()}] [Mercury → Neri] Closing dashboard`)
            overlayController?.hideNeri()
            break

          case 'create_canvas':
            console.log(`[${ts()}] [Mercury → Neri] Creating canvas: ${tr.title}`)
            if (overlayController) {
              overlayController.showNeri()
              const overlayWindow = overlayController.getWindow()
              if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('neri:openCanvasWindow', {
                  title: tr.title ?? 'Canvas',
                  html: tr.html ?? '',
                })
              }
            }
            break

          case 'manage_windows':
            console.log(`[${ts()}] [Mercury → Neri] Manage windows: ${tr.operation} ${tr.window_type ?? ''}`)
            if (overlayController) {
              const overlayWindow = overlayController.getWindow()
              if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('neri:manageWindow', {
                  operation: tr.operation ?? 'list',
                  window_type: tr.window_type,
                })
              }
            }
            break

          case 'message_orchestrator':
            console.log(`[${ts()}] [Mercury] Delegated to orchestrator (fire-and-forget)`)
            break
          case 'no_response':
            console.log(`[${ts()}] [Mercury] No response needed (chitchat)`)
            break
        }
      }

      // Return spoken summary or text for voice agent to speak
      return spokenParts.join(' ') || data.text || ''
    } catch (err) {
      console.error(`[${ts()}] [voice:mercuryChat] Error:`, err)
      throw err instanceof Error ? err : new Error(String(err))
    }
  })
}
