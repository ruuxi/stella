import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ChatContext } from './chat-context.js'
import { getDevServerUrl } from './dev-url.js'
import { registerAllIpcHandlers } from './ipc/ipc-registry.js'
import { OverlayWindowController } from './overlay-window.js'
import { MouseHookManager } from './mouse-hook.js'
import type { PiHostRunner } from './pi-host-runner.js'
import { createPiHostRunner } from './pi-runtime/runner.js'
import { calculateSelectedWedge, type RadialWedge } from './radial-wedge.js'
import { cleanupSelectedTextProcess, getSelectedText, initSelectedTextProcess } from './selected-text.js'
import { AuthService } from './services/auth-service.js'
import { CaptureService } from './services/capture-service.js'
import { ExternalLinkService } from './services/external-link-service.js'
import { MiniBridgeService } from './services/mini-bridge-service.js'
import { WorkspaceService } from './services/workspace-service.js'
import * as bridgeManager from './system/bridge_manager.js'
import { getOrCreateDeviceIdentity, signDeviceHeartbeat } from './system/device.js'
import { resolveStellaHome } from './system/stella-home.js'
import type { CredentialRequestPayload, CredentialResponsePayload, UiState } from './types.js'
import { WindowManager } from './windows/window-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.NODE_ENV === 'development'
const AUTH_PROTOCOL = 'Stella'
const STELLA_SESSION_PARTITION = 'persist:Stella'
const SECURITY_POLICY_VERSION = 1
const SECURITY_APPROVAL_PREFIX = `v${SECURITY_POLICY_VERSION}:`
const WAKE_WORD_RESUME_DELAY_MS = 150
const RADIAL_SIZE = 280

export const bootstrapMainProcess = () => {
  const uiState: UiState = {
    mode: 'chat',
    window: 'full',
    view: 'chat',
    conversationId: null,
    isVoiceActive: false,
    isVoiceRtcActive: false,
  }

  let appReady = false
  let isQuitting = false
  let deviceId: string | null = null
  let stellaHomePath: string | null = null
  let piHostRunner: PiHostRunner | null = null
  let securityPolicyPath: string | null = null
  let resumeWakeWordCapture: (() => void) | null = null
  let resumeWakeWordTimer: ReturnType<typeof setTimeout> | null = null
  let mouseHook: MouseHookManager | null = null
  let windowManager: WindowManager | null = null
  let overlayController: OverlayWindowController | null = null

  // Gesture-local radial state; capture internals live in CaptureService.
  let radialSelectionCommitted = false
  let radialStartedWithMiniVisible = false
  let radialContextBeforeGesture: ChatContext | null = null

  const trustedPrivilegedActions = new Set<string>()

  const workspaceService = new WorkspaceService(__dirname)
  const externalLinkService = new ExternalLinkService()
  const miniBridgeService = new MiniBridgeService()

  const scheduleResumeWakeWord = () => {
    if (resumeWakeWordTimer) clearTimeout(resumeWakeWordTimer)
    resumeWakeWordTimer = setTimeout(() => {
      resumeWakeWordTimer = null
      resumeWakeWordCapture?.()
    }, WAKE_WORD_RESUME_DELAY_MS)
  }

  const broadcastUiState = () => {
    const targets = windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()
    for (const window of targets) {
      window.webContents.send('ui:state', uiState)
    }
  }

  const updateUiState = (partial: Partial<UiState>) => {
    Object.assign(uiState, partial)
    broadcastUiState()
  }

  const getStandaloneVoicePosition = (mode: 'stt' | 'realtime') => {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const yOffset = mode === 'realtime' ? 88 : 56
    return {
      x: display.bounds.x + Math.round(display.bounds.width / 2),
      y: display.bounds.y + display.bounds.height - yOffset,
    }
  }

  const syncVoiceOverlay = () => {
    if (!overlayController) return
    if (uiState.isVoiceRtcActive) {
      const pos = getStandaloneVoicePosition('realtime')
      overlayController.showVoice(pos.x, pos.y, 'realtime')
      return
    }
    if (uiState.isVoiceActive) {
      const pos = getStandaloneVoicePosition('stt')
      overlayController.showVoice(pos.x, pos.y, 'stt')
      return
    }
    overlayController.hideVoice()
  }

  const deactivateVoiceModes = () => {
    if (!uiState.isVoiceActive && !uiState.isVoiceRtcActive) {
      return false
    }
    uiState.isVoiceActive = false
    uiState.isVoiceRtcActive = false
    syncVoiceOverlay()
    scheduleResumeWakeWord()
    broadcastUiState()
    return true
  }

  const captureService = new CaptureService({
    getAllWindows: () => (windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()),
    getMiniWindow: () => windowManager?.getMiniWindow() ?? null,
    isMiniShowing: () => windowManager?.isMiniShowing() ?? false,
    showWindow: (target) => windowManager?.showWindow(target),
    concealMiniWindowForCapture: () => windowManager?.concealMiniWindowForCapture() ?? false,
    restoreMiniWindowAfterCapture: () => {
      windowManager?.restoreMiniWindowAfterCapture()
    },
    updateUiState,
    hideRadial: () => overlayController?.hideRadial(),
    hideModifierBlock: () => overlayController?.hideModifierBlock(),
    startRegionCapture: () => overlayController?.startRegionCapture(),
    endRegionCapture: () => overlayController?.endRegionCapture(),
    getOverlayBounds: () => overlayController?.getWindow()?.getBounds() ?? null,
  })

  const broadcastAuthCallback = (url: string) => {
    const targets = windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()
    for (const window of targets) {
      window.webContents.send('auth:callback', { url })
    }
  }

  const authService = new AuthService({
    authProtocol: AUTH_PROTOCOL,
    isDev,
    projectDir: path.resolve(__dirname, '..'),
    sessionPartition: STELLA_SESSION_PARTITION,
    getRunner: () => piHostRunner,
    onAuthCallback: (url) => {
      windowManager?.showWindow('full')
      broadcastAuthCallback(url)
    },
    onSecondInstanceFocus: () => {
      windowManager?.getFullWindow()?.focus()
    },
  })

  if (!authService.enforceSingleInstanceLock()) {
    return
  }
  authService.bindOpenUrlHandler()

  const approvalKey = (action: string) => `${SECURITY_APPROVAL_PREFIX}${action}`

  const loadSecurityPolicy = async () => {
    if (!securityPolicyPath) return
    try {
      const raw = await fs.readFile(securityPolicyPath, 'utf-8')
      const parsed = JSON.parse(raw) as { approved?: unknown }
      const approved = Array.isArray(parsed?.approved) ? parsed.approved : []
      trustedPrivilegedActions.clear()
      for (const entry of approved) {
        if (typeof entry === 'string' && entry.startsWith(SECURITY_APPROVAL_PREFIX)) {
          trustedPrivilegedActions.add(entry)
        }
      }
    } catch {
      // File missing/invalid -> treat as no approvals.
    }
  }

  const persistSecurityPolicy = async () => {
    if (!securityPolicyPath) return
    try {
      await fs.mkdir(path.dirname(securityPolicyPath), { recursive: true })
      await fs.writeFile(
        securityPolicyPath,
        JSON.stringify(
          {
            version: SECURITY_POLICY_VERSION,
            approved: [...trustedPrivilegedActions].sort(),
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch (error) {
      console.warn('[security] Failed to persist security policy', error)
    }
  }

  const ensurePrivilegedActionApproval = async (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => {
    const key = approvalKey(action)
    if (trustedPrivilegedActions.has(key)) {
      return true
    }

    const ownerWindow =
      (event ? BrowserWindow.fromWebContents(event.sender) : null) ??
      BrowserWindow.getFocusedWindow() ??
      windowManager?.getFullWindow() ??
      undefined

    const dialogOptions: MessageBoxOptions = {
      type: 'warning',
      title: 'Stella Security Confirmation',
      message,
      detail,
      buttons: ['Allow', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: 'Remember this decision on this device',
      checkboxChecked: true,
    }

    const choice = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions)

    if (choice.response !== 0) {
      return false
    }

    if (choice.checkboxChecked) {
      trustedPrivilegedActions.add(key)
      await persistSecurityPolicy()
    }

    return true
  }

  const pendingCredentialRequests = new Map<
    string,
    {
      resolve: (value: CredentialResponsePayload) => void
      reject: (reason?: Error) => void
      timeout: NodeJS.Timeout
    }
  >()

  const requestCredential = async (
    payload: Omit<CredentialRequestPayload, 'requestId'>,
  ) => {
    const requestId = randomUUID()
    const request: CredentialRequestPayload = { requestId, ...payload }

    const focused = BrowserWindow.getFocusedWindow()
    const fullWindow = windowManager?.getFullWindow() ?? null
    const targetWindows = focused ? [focused] : fullWindow ? [fullWindow] : BrowserWindow.getAllWindows()
    if (targetWindows.length === 0) {
      throw new Error('No window available to collect credentials.')
    }

    for (const window of targetWindows) {
      window.webContents.send('credential:request', request)
    }

    return new Promise<CredentialResponsePayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCredentialRequests.delete(requestId)
        reject(new Error('Credential request timed out.'))
      }, 5 * 60 * 1000)
      pendingCredentialRequests.set(requestId, { resolve, reject, timeout })
    })
  }

  const submitCredential = (payload: CredentialResponsePayload) => {
    const pending = pendingCredentialRequests.get(payload.requestId)
    if (!pending) {
      return { ok: false, error: 'Credential request not found.' }
    }
    clearTimeout(pending.timeout)
    pendingCredentialRequests.delete(payload.requestId)
    pending.resolve(payload)
    return { ok: true }
  }

  const cancelCredential = (payload: { requestId: string }) => {
    const pending = pendingCredentialRequests.get(payload.requestId)
    if (!pending) {
      return { ok: false, error: 'Credential request not found.' }
    }
    clearTimeout(pending.timeout)
    pendingCredentialRequests.delete(payload.requestId)
    pending.reject(new Error('Credential request cancelled.'))
    return { ok: true }
  }

  const initializePiHostRunner = async () => {
    const stellaHome = await resolveStellaHome(app)
    stellaHomePath = stellaHome.homePath
    securityPolicyPath = path.join(stellaHome.statePath, 'security_policy.json')
    await loadSecurityPolicy()

    const deviceIdentity = await getOrCreateDeviceIdentity(stellaHome.statePath)
    deviceId = deviceIdentity.deviceId
    piHostRunner = createPiHostRunner({
      deviceId,
      StellaHome: stellaHome.homePath,
      frontendRoot: path.resolve(__dirname, '..'),
      requestCredential,
      signHeartbeatPayload: async (signedAtMs: number) => ({
        publicKey: deviceIdentity.publicKey,
        signature: signDeviceHeartbeat(deviceIdentity, signedAtMs),
      }),
    })

    const pendingConvexUrl = authService.getPendingConvexUrl()
    if (pendingConvexUrl) {
      piHostRunner.setConvexUrl(pendingConvexUrl)
    }
    piHostRunner.start()
  }

  const hardResetLocalState = async (_event: IpcMainInvokeEvent): Promise<{ ok: true }> => {
    const hadRunner = Boolean(piHostRunner)

    for (const [, pending] of pendingCredentialRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Credential request cancelled.'))
    }
    pendingCredentialRequests.clear()

    if (piHostRunner) {
      piHostRunner.stop()
      piHostRunner = null
    }

    authService.setHostAuthState(false)
    appReady = false
    authService.clearPendingAuthCallback()
    uiState.isVoiceActive = false
    uiState.isVoiceRtcActive = false
    syncVoiceOverlay()
    captureService.resetForHardReset()
    windowManager?.hideMiniWindow(false)

    trustedPrivilegedActions.clear()
    externalLinkService.clearSenderRateLimits()

    const appSession = session.fromPartition(STELLA_SESSION_PARTITION)
    await Promise.allSettled([
      appSession.clearStorageData(),
      appSession.clearCache(),
    ])

    const homePath = app.getPath('home')
    await Promise.allSettled([
      fs.rm(path.join(homePath, '.stella'), { recursive: true, force: true }),
      fs.rm(path.join(homePath, '.Stella'), { recursive: true, force: true }),
    ])

    if (hadRunner) {
      await initializePiHostRunner()
    }

    broadcastUiState()
    return { ok: true }
  }

  const handleRadialSelection = async (wedge: RadialWedge) => {
    switch (wedge) {
      case 'dismiss': {
        captureService.cancelRadialContextCapture()
        const pendingChatContext = captureService.getChatContextSnapshot()
        if (radialStartedWithMiniVisible) {
          if (pendingChatContext !== radialContextBeforeGesture) {
            captureService.setPendingChatContext(radialContextBeforeGesture)
          }
        } else if (pendingChatContext !== null) {
          if (pendingChatContext.regionScreenshots?.length) {
            captureService.setPendingChatContext({
              ...captureService.emptyContext(),
              regionScreenshots: pendingChatContext.regionScreenshots,
            })
          } else {
            captureService.setPendingChatContext(null)
          }
        }
        break
      }
      case 'capture': {
        captureService.setRadialContextShouldCommit(true)
        captureService.commitStagedRadialContext(radialContextBeforeGesture)
        captureService.cancelRadialContextCapture()
        updateUiState({ mode: 'chat' })
        overlayController?.hideRadial()
        overlayController?.hideModifierBlock()
        const miniWasConcealed = windowManager?.concealMiniWindowForCapture() ?? false
        const regionCapture = await captureService.startRegionCapture()
        if (regionCapture && (regionCapture.screenshot || regionCapture.window)) {
          const ctx = captureService.getChatContextSnapshot() ?? captureService.emptyContext()
          const existing = ctx.regionScreenshots ?? []
          const nextScreenshots = regionCapture.screenshot
            ? [...existing, regionCapture.screenshot]
            : existing
          captureService.setPendingChatContext({
            ...ctx,
            window: regionCapture.window ?? ctx.window,
            regionScreenshots: nextScreenshots,
          })
        }
        if (miniWasConcealed) {
          windowManager?.restoreMiniWindowAfterCapture()
        }
        if (!windowManager?.isMiniShowing()) {
          windowManager?.showWindow('mini')
        } else {
          captureService.broadcastChatContext()
        }
        break
      }
      case 'chat':
      case 'auto': {
        if (windowManager?.isMiniShowing()) {
          windowManager.hideMiniWindow(true)
        } else {
          captureService.setRadialContextShouldCommit(true)
          captureService.commitStagedRadialContext(radialContextBeforeGesture)
          updateUiState({ mode: 'chat' })
          windowManager?.showWindow('mini')
        }
        break
      }
      case 'voice':
        break
      case 'full':
        captureService.cancelRadialContextCapture()
        captureService.setPendingChatContext(null)
        windowManager?.showWindow('full')
        break
    }
  }

  const initMouseHook = () => {
    mouseHook = new MouseHookManager({
      onModifierDown: () => {
        if (process.platform === 'darwin') {
          overlayController?.showModifierBlockPreemptive()
        }
      },
      onModifierUp: () => {
        if (
          !windowManager?.isMiniShowing() &&
          !windowManager?.hasPendingMiniShow() &&
          !captureService.hasPendingRadialCapture()
        ) {
          const pendingChatContext = captureService.getChatContextSnapshot()
          if (pendingChatContext?.regionScreenshots?.length) {
            captureService.setPendingChatContext({
              ...captureService.emptyContext(),
              regionScreenshots: pendingChatContext.regionScreenshots,
            })
          } else {
            captureService.setPendingChatContext(null)
          }
        }
        if (process.platform === 'darwin') {
          if (!mouseHook?.isRadialActive()) {
            overlayController?.hideModifierBlock()
          }
        }
      },
      onLeftClick: () => {
        // Mini shell no longer auto-hides on external click.
      },
      onRadialShow: (x: number, y: number) => {
        if (!appReady) return
        radialStartedWithMiniVisible = windowManager?.isMiniShowing() ?? false
        radialContextBeforeGesture = captureService.getChatContextSnapshot()
        captureService.setRadialContextShouldCommit(false)

        const miniWindow = windowManager?.getMiniWindow() ?? null
        if (radialStartedWithMiniVisible && miniWindow) {
          miniWindow.webContents.send('mini:dismissPreview')
        }

        const pendingChatContext = captureService.getChatContextSnapshot()
        if (!radialStartedWithMiniVisible && pendingChatContext) {
          const hasTransientContext = Boolean(
            pendingChatContext.window ||
            pendingChatContext.selectedText ||
            pendingChatContext.browserUrl,
          )
          if (hasTransientContext) {
            captureService.setPendingChatContext({
              window: null,
              browserUrl: null,
              selectedText: null,
              regionScreenshots: pendingChatContext.regionScreenshots ?? [],
            })
          }
        }

        radialSelectionCommitted = false
        overlayController?.showRadial(x, y)
        overlayController?.showModifierBlock()
        captureService.captureRadialContext(x, y, radialContextBeforeGesture)
      },
      onRadialHide: () => {
        if (!radialSelectionCommitted) {
          captureService.cancelRadialContextCapture()
          const pendingChatContext = captureService.getChatContextSnapshot()
          if (radialStartedWithMiniVisible) {
            if (pendingChatContext !== radialContextBeforeGesture) {
              captureService.setPendingChatContext(radialContextBeforeGesture)
            }
          } else if (!windowManager?.hasPendingMiniShow() && pendingChatContext !== null) {
            if (pendingChatContext.regionScreenshots?.length) {
              captureService.setPendingChatContext({
                ...captureService.emptyContext(),
                regionScreenshots: pendingChatContext.regionScreenshots,
              })
            } else {
              captureService.setPendingChatContext(null)
            }
          }
        }
        radialSelectionCommitted = false
        overlayController?.hideRadial()
        overlayController?.hideModifierBlock()
      },
      onMouseMove: (x: number, y: number) => {
        overlayController?.updateRadialCursor(x, y)
      },
      onMouseUp: (_x: number, _y: number) => {
        const radialBounds = overlayController?.getRadialBounds()
        if (!radialBounds) {
          return
        }

        // Use Electron's DIP cursor position (uiohook reports physical pixels on Windows)
        const cursorDip = screen.getCursorScreenPoint()
        const relativeX = cursorDip.x - radialBounds.x
        const relativeY = cursorDip.y - radialBounds.y
        const wedge = calculateSelectedWedge(
          relativeX,
          relativeY,
          RADIAL_SIZE / 2,
          RADIAL_SIZE / 2,
        )
        radialSelectionCommitted = true
        void handleRadialSelection(wedge)
      },
    })

    mouseHook.start()
  }

  const initializeWakeWord = async () => {
    const { createWakeWordDetector } = await import('./wake-word/detector.js')
    const { createAudioCaptureManager } = await import('./wake-word/audio-capture.js')

    const modelsDir = isDev
      ? path.join(__dirname, '..', 'resources', 'models')
      : path.join(process.resourcesPath, 'models')

    try {
      const detector = await createWakeWordDetector(modelsDir)
      const capture = createAudioCaptureManager(detector)

      const TOKEN_PREFETCH_INTERVAL_MS = 50_000
      let tokenPrefetchTimer: ReturnType<typeof setInterval> | null = null

      const getVoiceTargetWindow = () => {
        // Standalone voice is owned by the unified overlay window.
        // Fallback to mini only if overlay has not been created yet.
        return overlayController?.getWindow() ?? windowManager?.getMiniWindow() ?? null
      }

      const startTokenPrefetch = () => {
        stopTokenPrefetch()
        const target = getVoiceTargetWindow()
        if (target) target.webContents.send('voice-rtc:prefetch-token')
        tokenPrefetchTimer = setInterval(() => {
          const current = getVoiceTargetWindow()
          if (current) current.webContents.send('voice-rtc:prefetch-token')
        }, TOKEN_PREFETCH_INTERVAL_MS)
      }

      const stopTokenPrefetch = () => {
        if (tokenPrefetchTimer) {
          clearInterval(tokenPrefetchTimer)
          tokenPrefetchTimer = null
        }
      }

      capture.onDetection((result) => {
        if (!appReady) return
        const t0 = Date.now()
        console.log(`[VoiceRTC:main] t+0ms wake-word detected score=${result.score.toFixed(3)} vad=${result.vadScore.toFixed(3)}`)

        const convId = uiState.conversationId ?? 'voice-rtc'
        const voiceTarget = getVoiceTargetWindow()
        if (voiceTarget) {
          voiceTarget.webContents.send('voice-rtc:pre-warm', convId)
          console.log(`[VoiceRTC:main] t+${Date.now() - t0}ms pre-warm IPC sent`)
        }

        uiState.isVoiceRtcActive = true
        uiState.isVoiceActive = false
        uiState.mode = 'voice'
        syncVoiceOverlay()
        console.log(`[VoiceRTC:main] t+${Date.now() - t0}ms overlay voice activated + broadcastUiState`)
        broadcastUiState()

        stopTokenPrefetch()
        // Fully release the wake-word microphone stream before realtime RTC starts.
        capture.stop({ releaseDevice: true })
      })

      const tryStartCapture = () => {
        if (!capture.isCapturing()) {
          capture.start()
          startTokenPrefetch()
        }
      }

      if (appReady) {
        setTimeout(tryStartCapture, 150)
      }
      ipcMain.on('app:setReady', () => {
        setTimeout(tryStartCapture, 150)
      })

      resumeWakeWordCapture = () => {
        if (appReady && !uiState.isVoiceActive && !uiState.isVoiceRtcActive && !capture.isCapturing()) {
          console.log('[WakeWord] Resuming capture after voice deactivation')
          tryStartCapture()
        }
      }
    } catch (error) {
      console.error('[WakeWord] Failed to initialize:', (error as Error).message)
    }
  }

  app.whenReady().then(async () => {
    authService.registerAuthProtocol()
    authService.captureInitialAuthUrl(process.argv)

    initSelectedTextProcess()
    if (process.platform === 'win32') {
      setTimeout(() => {
        void getSelectedText()
      }, 250)
    }

    await initializePiHostRunner()

    // Create the unified overlay window first (mini shell now lives here)
    overlayController = new OverlayWindowController({
      preloadPath: path.join(__dirname, 'preload.js'),
      sessionPartition: STELLA_SESSION_PARTITION,
    })
    overlayController.create()

    windowManager = new WindowManager({
      electronDir: __dirname,
      preloadPath: path.join(__dirname, 'preload.js'),
      sessionPartition: STELLA_SESSION_PARTITION,
      isDev,
      getDevServerUrl,
      isAppReady: () => appReady,
      isQuitting: () => isQuitting,
      workspaceService,
      externalLinkService,
      miniBridgeService,
      chatContextSyncBridge: {
        getChatContextVersion: () => captureService.getChatContextVersion(),
        getLastBroadcastChatContextVersion: () => captureService.getLastBroadcastChatContextVersion(),
        broadcastChatContext: () => captureService.broadcastChatContext(),
        waitForMiniChatContext: (version: number) => captureService.waitForMiniChatContext(version),
      },
      onDeactivateVoiceModes: deactivateVoiceModes,
      onUpdateUiState: updateUiState,
      getOverlayController: () => overlayController,
    })

    windowManager.createInitialWindows()

    registerAllIpcHandlers({
      ui: {
        uiState,
        windowManager,
        updateUiState,
        broadcastUiState,
        syncVoiceOverlay,
        setAppReady: (ready) => { appReady = ready },
        getResumeWakeWordCapture: () => resumeWakeWordCapture,
        scheduleResumeWakeWord,
        deactivateVoiceModes,
      },
      capture: {
        captureService,
        windowManager,
      },
      system: {
        getDeviceId: () => deviceId,
        authService,
        getPiHostRunner: () => piHostRunner,
        getStellaHomePath: () => stellaHomePath,
        externalLinkService,
        ensurePrivilegedActionApproval,
        hardResetLocalState,
        submitCredential,
        cancelCredential,
      },
      browser: {
        getStellaHomePath: () => stellaHomePath,
        workspaceService,
      },
      agent: {
        getPiHostRunner: () => piHostRunner,
        isHostAuthAuthenticated: () => authService.getHostAuthAuthenticated(),
        frontendRoot: path.resolve(__dirname, '..'),
      },
      store: {
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
        ensurePrivilegedActionApproval,
        miniBridgeService,
        windowManager,
      },
      voice: {
        uiState,
        getAppReady: () => appReady,
        windowManager,
        broadcastUiState,
        scheduleResumeWakeWord,
        syncVoiceOverlay,
        getPiHostRunner: () => piHostRunner,
      },
    })

    windowManager.showWindow('full')

    const pendingAuthCallback = authService.consumePendingAuthCallback()
    const fullWindow = windowManager.getFullWindow()
    if (pendingAuthCallback && fullWindow) {
      fullWindow.webContents.once('did-finish-load', () => {
        broadcastAuthCallback(pendingAuthCallback)
      })
    }

    initMouseHook()
    await initializeWakeWord()

    app.on('activate', () => {
      windowManager?.onActivate()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    authService.stopAuthRefreshLoop()
    if (piHostRunner) {
      piHostRunner.killAllShells()
    }
    bridgeManager.stopAll()
    cleanupSelectedTextProcess()
    overlayController?.destroy()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (mouseHook) {
      mouseHook.stop()
      mouseHook = null
    }
    if (piHostRunner) {
      piHostRunner.stop()
      piHostRunner = null
    }
  })
}
