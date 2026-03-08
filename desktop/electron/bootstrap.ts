import { promises as fs } from 'fs'
import {
  app,
  BrowserWindow,
  globalShortcut,
  session,
} from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDevServerUrl } from './dev-url.js'
import { registerAllIpcHandlers } from './ipc/ipc-registry.js'
import { OverlayWindowController } from './windows/overlay-window.js'
import type { StellaHostRunner } from './stella-host-runner.js'
import { createStellaHostRunner } from './stella-host-runner.js'
import { ensureLastResortRecoveryScripts } from './self-mod/recovery-script.js'
import { cleanupSelectedTextProcess, getSelectedText, initSelectedTextProcess } from './selected-text.js'
import { AuthService } from './services/auth-service.js'
import { AudioDuckingService } from './services/audio-ducking-service.js'
import { CaptureService } from './services/capture-service.js'
import { CredentialService } from './services/credential-service.js'
import { ExternalLinkService } from './services/external-link-service.js'
import { MiniBridgeService } from './services/mini-bridge-service.js'
import { RadialGestureService } from './services/radial-gesture-service.js'
import { SecurityPolicyService } from './services/security-policy-service.js'
import { LocalSchedulerService } from './services/local-scheduler-service.js'
import { UiStateService } from './services/ui-state-service.js'
import { WorkspaceService } from './services/workspace-service.js'
import * as bridgeManager from './system/bridge-manager.js'
import { getOrCreateDeviceIdentity, signDeviceHeartbeat } from './system/device.js'
import { resolveStellaHome } from './system/stella-home.js'
import { initializeWakeWord } from './wake-word/initialize.js'
import { startStellaUiServer } from './system/stella-ui-server.js'
import { WindowManager } from './windows/window-manager.js'
import { VoiceRuntimeWindowController } from './windows/voice-runtime-window.js'
import { createHmrMorphOrchestrator } from './self-mod/hmr-morph.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.NODE_ENV === 'development'
const AUTH_PROTOCOL = 'Stella'
const STELLA_SESSION_PARTITION = 'persist:Stella'

export const bootstrapMainProcess = () => {
  let appReady = false
  let isQuitting = false
  let deviceId: string | null = null
  let stellaHomePath: string | null = null
  let stellaHostRunner: StellaHostRunner | null = null
  let schedulerService: LocalSchedulerService | null = null
  let windowManager: WindowManager | null = null
  let overlayController: OverlayWindowController | null = null
  let voiceRuntimeWindowController: VoiceRuntimeWindowController | null = null
  let hmrMorphOrchestrator: ReturnType<typeof createHmrMorphOrchestrator> | null = null

  // --- Core services (no deps or lightweight deps) ---

  const uiStateService = new UiStateService()
  const workspaceService = new WorkspaceService(__dirname)
  const externalLinkService = new ExternalLinkService()
  const miniBridgeService = new MiniBridgeService()
  const audioDuckingService = new AudioDuckingService(
    () => windowManager?.getAllWindows() ?? BrowserWindow.getAllWindows(),
  )

  const securityPolicyService = new SecurityPolicyService({
    getWindowManager: () => windowManager,
  })

  const credentialService = new CredentialService({
    getWindowManager: () => windowManager,
  })

  // --- Domain services (depend on core services) ---

  const captureService = new CaptureService({
    window: {
      getAllWindows: () => (windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()),
      getMiniWindow: () => windowManager?.getMiniWindow() ?? null,
      isMiniShowing: () => windowManager?.isMiniShowing() ?? false,
      showWindow: (target) => windowManager?.showWindow(target),
      concealMiniWindowForCapture: () => windowManager?.concealMiniWindowForCapture() ?? false,
      restoreMiniWindowAfterCapture: () => { windowManager?.restoreMiniWindowAfterCapture() },
    },
    overlay: {
      hideRadial: () => overlayController?.hideRadial(),
      hideModifierBlock: () => overlayController?.hideModifierBlock(),
      startRegionCapture: () => overlayController?.startRegionCapture(),
      endRegionCapture: () => overlayController?.endRegionCapture(),
      getOverlayBounds: () => overlayController?.getWindow()?.getBounds() ?? null,
    },
    updateUiState: (partial) => uiStateService.update(partial),
  })

  const authService = new AuthService({
    authProtocol: AUTH_PROTOCOL,
    isDev,
    projectDir: path.resolve(__dirname, '..'),
    sessionPartition: STELLA_SESSION_PARTITION,
    getRunner: () => stellaHostRunner,
    onAuthCallback: (url) => {
      windowManager?.showWindow('full')
      broadcastAuthCallback(url)
    },
    onSecondInstanceFocus: () => {
      windowManager?.getFullWindow()?.focus()
    },
  })

  const radialGestureService = new RadialGestureService({
    isAppReady: () => appReady,
    capture: {
      cancelRadialContextCapture: () => captureService.cancelRadialContextCapture(),
      getChatContextSnapshot: () => captureService.getChatContextSnapshot(),
      setPendingChatContext: (ctx) => captureService.setPendingChatContext(ctx),
      clearTransientContext: () => captureService.clearTransientContext(),
      setRadialContextShouldCommit: (commit) => captureService.setRadialContextShouldCommit(commit),
      commitStagedRadialContext: (before) => captureService.commitStagedRadialContext(before),
      hasPendingRadialCapture: () => captureService.hasPendingRadialCapture(),
      captureRadialContext: (x, y, before) => captureService.captureRadialContext(x, y, before),
      startRegionCapture: () => captureService.startRegionCapture(),
      emptyContext: () => captureService.emptyContext(),
      broadcastChatContext: () => captureService.broadcastChatContext(),
    },
    overlay: {
      showModifierBlock: () => overlayController?.showModifierBlock(),
      hideModifierBlock: () => overlayController?.hideModifierBlock(),
      showRadial: (x, y) => overlayController?.showRadial(x, y),
      hideRadial: () => overlayController?.hideRadial(),
      updateRadialCursor: (x, y) => overlayController?.updateRadialCursor(x, y),
      getRadialBounds: () => overlayController?.getRadialBounds() ?? null,
    },
    window: {
      isMiniShowing: () => windowManager?.isMiniShowing() ?? false,
      hasPendingMiniShow: () => windowManager?.hasPendingMiniShow() ?? false,
      getMiniWindow: () => windowManager?.getMiniWindow() ?? null,
      showWindow: (target) => windowManager?.showWindow(target),
      hideMiniWindow: (animate) => windowManager?.hideMiniWindow(animate),
      concealMiniWindowForCapture: () => windowManager?.concealMiniWindowForCapture() ?? false,
      restoreMiniWindowAfterCapture: () => windowManager?.restoreMiniWindowAfterCapture(),
    },
    updateUiState: (partial) => uiStateService.update(partial),
  })

  // --- Initialization helpers ---

  const broadcastAuthCallback = (url: string) => {
    const targets = windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()
    for (const window of targets) {
      window.webContents.send('auth:callback', { url })
    }
  }

  const initializeStellaHostRunner = async () => {
    const stellaHome = await resolveStellaHome(app)
    stellaHomePath = stellaHome.homePath
    try {
      await ensureLastResortRecoveryScripts({
        stellaHomePath: stellaHome.homePath,
        frontendRoot: path.resolve(__dirname, '..'),
      })
    } catch (error) {
      console.warn('[self-mod] Failed to write recovery scripts:', (error as Error).message)
    }
    securityPolicyService.setSecurityPolicyPath(
      path.join(stellaHome.statePath, 'security_policy.json'),
    )
    await securityPolicyService.loadPolicy()

    const deviceIdentity = await getOrCreateDeviceIdentity(stellaHome.statePath)
    deviceId = deviceIdentity.deviceId
    if (!schedulerService) {
      schedulerService = new LocalSchedulerService({
        stellaHome: stellaHome.homePath,
        getRunner: () => stellaHostRunner,
      })
    } else {
      schedulerService.stop()
    }
    stellaHostRunner = createStellaHostRunner({
      deviceId,
      StellaHome: stellaHome.homePath,
      frontendRoot: path.resolve(__dirname, '..'),
      getHmrMorphOrchestrator: () => hmrMorphOrchestrator,
      requestCredential: (payload) => credentialService.requestCredential(payload),
      displayHtml: (html) => {
        const targets = windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()
        for (const win of targets) {
          if (!win.isDestroyed()) {
            win.webContents.send('display:update', html)
          }
        }
      },
      newsHtml: (html) => {
        const targets = windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows()
        for (const win of targets) {
          if (!win.isDestroyed()) {
            win.webContents.send('news:update', html)
          }
        }
      },
      scheduleApi: {
        listCronJobs: async () => schedulerService!.listCronJobs(),
        addCronJob: async (input) => schedulerService!.addCronJob(input),
        updateCronJob: async (jobId, patch) => schedulerService!.updateCronJob(jobId, patch),
        removeCronJob: async (jobId) => schedulerService!.removeCronJob(jobId),
        runCronJob: async (jobId) => schedulerService!.runCronJob(jobId),
        getHeartbeatConfig: async (conversationId) =>
          schedulerService!.getHeartbeatConfig(conversationId),
        upsertHeartbeat: async (input) => schedulerService!.upsertHeartbeat(input),
        runHeartbeat: async (conversationId) => schedulerService!.runHeartbeat(conversationId),
      },
      signHeartbeatPayload: async (signedAtMs: number) => ({
        publicKey: deviceIdentity.publicKey,
        signature: signDeviceHeartbeat(deviceIdentity, signedAtMs),
      }),
    })

    const pendingConvexUrl = authService.getPendingConvexUrl()
    if (pendingConvexUrl) {
      stellaHostRunner.setConvexUrl(pendingConvexUrl)
    }
    stellaHostRunner.start()
    schedulerService.start()
  }

  const hardResetLocalState = async (): Promise<{ ok: true }> => {
    const hadRunner = Boolean(stellaHostRunner)

    credentialService.cancelAll()

    if (stellaHostRunner) {
      stellaHostRunner.stop()
      stellaHostRunner = null
    }
    if (schedulerService) {
      schedulerService.stop()
    }

    authService.setHostAuthState(false)
    appReady = false
    authService.clearPendingAuthCallback()
    uiStateService.state.isVoiceActive = false
    uiStateService.state.isVoiceRtcActive = false
    uiStateService.syncVoiceOverlay()
    captureService.resetForHardReset()
    windowManager?.hideMiniWindow(false)

    securityPolicyService.clearAll()
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
      await initializeStellaHostRunner()
    }

    uiStateService.broadcast()
    return { ok: true }
  }

  // --- Single-instance lock ---

  if (!authService.enforceSingleInstanceLock()) {
    return
  }
  authService.bindOpenUrlHandler()

  // --- App lifecycle ---

  app.whenReady().then(async () => {
    authService.registerAuthProtocol()
    authService.captureInitialAuthUrl(process.argv)

    initSelectedTextProcess()
    if (process.platform === 'win32') {
      setTimeout(() => { void getSelectedText() }, 250)
    }

    await initializeStellaHostRunner()

    overlayController = new OverlayWindowController({
      preloadPath: path.join(__dirname, 'preload.js'),
      sessionPartition: STELLA_SESSION_PARTITION,
      electronDir: __dirname,
      isDev,
      getDevServerUrl,
    })
    overlayController.create()

    voiceRuntimeWindowController = new VoiceRuntimeWindowController({
      preloadPath: path.join(__dirname, 'preload.js'),
      sessionPartition: STELLA_SESSION_PARTITION,
      electronDir: __dirname,
      isDev,
      getDevServerUrl,
      onRenderProcessGone: (details) => {
        console.error('[voice-runtime] Renderer process gone:', details.reason)
      },
    })

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
      onDeactivateVoiceModes: () => uiStateService.deactivateVoiceModes(),
      onUpdateUiState: (partial) => uiStateService.update(partial),
      getOverlayController: () => overlayController,
    })

    // Bind UI state service to window + overlay targets (deferred until both exist)
    uiStateService.bind({
      broadcastTarget: {
        getAllWindows: () => windowManager ? windowManager.getAllWindows() : BrowserWindow.getAllWindows(),
      },
      getOverlayTarget: () => overlayController ? {
        showVoice: (x, y, mode) => overlayController!.showVoice(x, y, mode),
        hideVoice: () => overlayController!.hideVoice(),
      } : null,
    })

    windowManager.createInitialWindows()

    // Start stella-ui server for agent UI control
    startStellaUiServer({
      getWindow: () => windowManager?.getFullWindow() ?? null,
      frontendRoot: path.resolve(__dirname, '..'),
      getProxy: () => stellaHostRunner?.getProxy() ?? null,
    })
    hmrMorphOrchestrator = createHmrMorphOrchestrator({
      getFullWindow: () => windowManager?.getFullWindow() ?? null,
      getOverlayController: () => overlayController,
    })

    registerAllIpcHandlers({
      ui: {
        uiState: uiStateService.state,
        windowManager,
        updateUiState: (partial) => uiStateService.update(partial),
        broadcastUiState: () => uiStateService.broadcast(),
        syncVoiceOverlay: () => uiStateService.syncVoiceOverlay(),
        setAppReady: (ready) => { appReady = ready },
        getResumeWakeWordCapture: () => uiStateService.getResumeWakeWordCapture(),
        scheduleResumeWakeWord: () => uiStateService.scheduleResumeWakeWord(),
        deactivateVoiceModes: () => uiStateService.deactivateVoiceModes(),
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
      },
      capture: {
        captureService,
        windowManager,
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
      },
      system: {
        getDeviceId: () => deviceId,
        authService,
        getStellaHostRunner: () => stellaHostRunner,
        getStellaHomePath: () => stellaHomePath,
        externalLinkService,
        ensurePrivilegedActionApproval: (action, message, detail, event) =>
          securityPolicyService.ensureApproval(action, message, detail, event),
        hardResetLocalState,
        submitCredential: (payload) => credentialService.submitCredential(payload),
        cancelCredential: (payload) => credentialService.cancelCredential(payload),
      },
      schedule: {
        schedulerService: schedulerService!,
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
      },
      browser: {
        getStellaHomePath: () => stellaHomePath,
        workspaceService,
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
      },
      agent: {
        getStellaHostRunner: () => stellaHostRunner,
        isHostAuthAuthenticated: () => authService.getHostAuthAuthenticated(),
        frontendRoot: path.resolve(__dirname, '..'),
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
        hmrMorphOrchestrator,
      },
      miniBridge: {
        miniBridgeService,
        windowManager,
      },
      store: {
        assertPrivilegedSender: (event, channel) =>
          externalLinkService.assertPrivilegedSender(event, channel),
        ensurePrivilegedActionApproval: (action, message, detail, event) =>
          securityPolicyService.ensureApproval(action, message, detail, event),
      },
      voice: {
        uiState: uiStateService.state,
        getAppReady: () => appReady,
        windowManager,
        broadcastUiState: () => uiStateService.broadcast(),
        scheduleResumeWakeWord: () => uiStateService.scheduleResumeWakeWord(),
        syncVoiceOverlay: () => uiStateService.syncVoiceOverlay(),
        getStellaHostRunner: () => stellaHostRunner,
        getOverlayController: () => overlayController,
        getConvexSiteUrl: () => authService.getConvexSiteUrl(),
        getAuthToken: () => authService.getAuthToken(),
        setAssistantSpeaking: (active) => audioDuckingService.setAssistantSpeaking(active),
      },
    })

    voiceRuntimeWindowController.create()

    windowManager.showWindow('full')

    const pendingAuthCallback = authService.consumePendingAuthCallback()
    const fullWindow = windowManager.getFullWindow()
    if (pendingAuthCallback && fullWindow) {
      fullWindow.webContents.once('did-finish-load', () => {
        broadcastAuthCallback(pendingAuthCallback)
      })
    }

    radialGestureService.start()

    try {
      await initializeWakeWord({
        isDev,
        electronDir: __dirname,
        uiStateService,
        isAppReady: () => appReady,
        getVoiceTargetWindow: () =>
          overlayController?.getWindow() ?? windowManager?.getMiniWindow() ?? null,
      })
    } catch (error) {
      console.error('[WakeWord] Failed to initialize:', (error as Error).message)
    }

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
    if (stellaHostRunner) {
      stellaHostRunner.killAllShells()
    }
    schedulerService?.stop()
    bridgeManager.stopAll()
    cleanupSelectedTextProcess()
    overlayController?.destroy()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    radialGestureService.stop()
    if (stellaHostRunner) {
      stellaHostRunner.stop()
      stellaHostRunner = null
    }
    if (schedulerService) {
      schedulerService.stop()
    }
  })
}
