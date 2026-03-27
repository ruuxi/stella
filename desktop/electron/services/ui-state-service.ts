import { BrowserWindow, screen } from 'electron'
import type { UiState } from '../types.js'

export type UiStateBroadcastTarget = {
  getAllWindows: () => BrowserWindow[]
}

export type VoiceOverlayTarget = {
  showVoice: (x: number, y: number, mode: 'stt' | 'realtime') => void
  hideVoice: () => void
}

export type UiStateServiceDeps = {
  broadcastTarget: UiStateBroadcastTarget
  getOverlayTarget: () => VoiceOverlayTarget | null
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null
}

export class UiStateService {
  readonly state: UiState = {
    mode: 'chat',
    window: 'full',
    view: 'chat',
    conversationId: null,
    isVoiceActive: false,
    isVoiceRtcActive: false,
  }

  private deps: UiStateServiceDeps | null = null
  private resumeWakeWordCapture: (() => void) | null = null
  private resumeWakeWordTimer: ReturnType<typeof setTimeout> | null = null

  private static readonly WAKE_WORD_RESUME_DELAY_MS = 150

  bind(deps: UiStateServiceDeps) {
    this.deps = deps
  }

  update(partial: Partial<UiState>) {
    Object.assign(this.state, partial)
    this.broadcast()
  }

  broadcast() {
    if (!this.deps) return
    const targets = this.deps.broadcastTarget.getAllWindows()
    for (const window of targets) {
      window.webContents.send('ui:state', this.state)
    }
    this.deps.getBroadcastToMobile?.()?.('ui:state', this.state)
  }

  syncVoiceOverlay() {
    const overlay = this.deps?.getOverlayTarget()
    if (!overlay) return
    if (this.state.isVoiceRtcActive) {
      const pos = this.getStandaloneVoicePosition('realtime')
      overlay.showVoice(pos.x, pos.y, 'realtime')
      return
    }
    if (this.state.isVoiceActive) {
      const pos = this.getStandaloneVoicePosition('stt')
      overlay.showVoice(pos.x, pos.y, 'stt')
      return
    }
    overlay.hideVoice()
  }

  deactivateVoiceModes(): boolean {
    if (!this.state.isVoiceActive && !this.state.isVoiceRtcActive) {
      return false
    }
    this.state.isVoiceActive = false
    this.state.isVoiceRtcActive = false
    this.syncVoiceOverlay()
    this.scheduleResumeWakeWord()
    this.broadcast()
    return true
  }

  activateVoiceRtc(conversationId: string | null) {
    this.state.isVoiceRtcActive = true
    this.state.isVoiceActive = false
    this.state.mode = 'voice'
    this.state.conversationId = conversationId ?? this.state.conversationId
    this.syncVoiceOverlay()
    this.broadcast()
  }

  setResumeWakeWordCapture(fn: (() => void) | null) {
    this.resumeWakeWordCapture = fn
  }

  getResumeWakeWordCapture(): (() => void) | null {
    return this.resumeWakeWordCapture
  }

  scheduleResumeWakeWord() {
    if (this.resumeWakeWordTimer) clearTimeout(this.resumeWakeWordTimer)
    this.resumeWakeWordTimer = setTimeout(() => {
      this.resumeWakeWordTimer = null
      this.resumeWakeWordCapture?.()
    }, UiStateService.WAKE_WORD_RESUME_DELAY_MS)
  }

  private getStandaloneVoicePosition(mode: 'stt' | 'realtime') {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const yOffset = mode === 'realtime' ? 88 : 56
    return {
      x: display.bounds.x + Math.round(display.bounds.width / 2),
      y: display.bounds.y + display.bounds.height - yOffset,
    }
  }
}
