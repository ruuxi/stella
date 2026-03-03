import path from 'path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { UiStateService } from '../services/ui-state-service.js'

export type WakeWordDeps = {
  isDev: boolean
  electronDir: string
  uiStateService: UiStateService
  isAppReady: () => boolean
  getVoiceTargetWindow: () => BrowserWindow | null
}

export const initializeWakeWord = async (deps: WakeWordDeps) => {
  const { createWakeWordDetector } = await import('./detector.js')
  const { createAudioCaptureManager } = await import('./audio-capture.js')

  const modelsDir = deps.isDev
    ? path.join(deps.electronDir, '..', 'resources', 'models')
    : path.join(process.resourcesPath, 'models')

  const detector = await createWakeWordDetector(modelsDir)
  const capture = createAudioCaptureManager(detector)

  const TOKEN_PREFETCH_INTERVAL_MS = 50_000
  let tokenPrefetchTimer: ReturnType<typeof setInterval> | null = null

  const startTokenPrefetch = () => {
    stopTokenPrefetch()
    const target = deps.getVoiceTargetWindow()
    if (target) target.webContents.send('voice-rtc:prefetch-token')
    tokenPrefetchTimer = setInterval(() => {
      const current = deps.getVoiceTargetWindow()
      if (current) current.webContents.send('voice-rtc:prefetch-token')
    }, TOKEN_PREFETCH_INTERVAL_MS)
  }

  const stopTokenPrefetch = () => {
    if (tokenPrefetchTimer) {
      clearInterval(tokenPrefetchTimer)
      tokenPrefetchTimer = null
    }
  }

  capture.onDetection(() => {
    if (!deps.isAppReady()) return

    const convId = deps.uiStateService.state.conversationId ?? 'voice-rtc'
    const voiceTarget = deps.getVoiceTargetWindow()
    if (voiceTarget) {
      voiceTarget.webContents.send('voice-rtc:pre-warm', convId)
    }

    deps.uiStateService.activateVoiceRtc(convId !== 'voice-rtc' ? convId : null)
    stopTokenPrefetch()
    capture.stop({ releaseDevice: true })
  })

  const tryStartCapture = () => {
    if (!capture.isCapturing()) {
      capture.start()
      startTokenPrefetch()
    }
  }

  if (deps.isAppReady()) {
    setTimeout(tryStartCapture, 150)
  }
  ipcMain.on('app:setReady', () => {
    setTimeout(tryStartCapture, 150)
  })

  deps.uiStateService.setResumeWakeWordCapture(() => {
    const { isVoiceActive, isVoiceRtcActive } = deps.uiStateService.state
    if (deps.isAppReady() && !isVoiceActive && !isVoiceRtcActive && !capture.isCapturing()) {
      tryStartCapture()
    }
  })
}
