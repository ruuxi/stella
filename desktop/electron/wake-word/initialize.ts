import path from 'path'
import { ipcMain } from 'electron'
import type { UiStateService } from '../services/ui-state-service.js'

export type WakeWordDeps = {
  isDev: boolean
  electronDir: string
  uiStateService: UiStateService
  isAppReady: () => boolean
}

export const initializeWakeWord = async (deps: WakeWordDeps) => {
  const { createWakeWordDetector } = await import('./detector.js')
  const { createAudioCaptureManager } = await import('./audio-capture.js')

  const modelsDir = deps.isDev
    ? path.join(deps.electronDir, '..', '..', 'resources', 'models')
    : path.join(process.resourcesPath, 'models')

  const detector = await createWakeWordDetector(modelsDir)
  const capture = createAudioCaptureManager(detector)

  capture.onDetection(() => {
    if (!deps.isAppReady()) return

    const convId = deps.uiStateService.state.conversationId ?? 'voice-rtc'
    deps.uiStateService.activateVoiceRtc(convId !== 'voice-rtc' ? convId : null)
    capture.stop({ releaseDevice: true })
  })

  const tryStartCapture = () => {
    if (!capture.isCapturing()) {
      capture.start()
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
