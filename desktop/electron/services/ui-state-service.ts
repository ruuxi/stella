import { BrowserWindow, screen } from 'electron'
import type { UiState } from '../types.js'

export type UiStateBroadcastTarget = {
  getAllWindows: () => BrowserWindow[]
}

export type VoiceOverlayTarget = {
  showVoice: (x: number, y: number, mode: 'realtime') => void
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
    isVoiceRtcActive: false,
    suppressNativeContextMenuDuringOnboarding: false,
  }

  private deps: UiStateServiceDeps | null = null

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
      const pos = this.getStandaloneVoicePosition()
      overlay.showVoice(pos.x, pos.y, 'realtime')
      return
    }
    overlay.hideVoice()
  }

  deactivateVoiceModes(): boolean {
    if (!this.state.isVoiceRtcActive) {
      return false
    }
    this.state.isVoiceRtcActive = false
    this.syncVoiceOverlay()
    this.broadcast()
    return true
  }

  activateVoiceRtc(conversationId: string | null) {
    this.state.isVoiceRtcActive = true
    this.state.mode = 'voice'
    this.state.conversationId = conversationId ?? this.state.conversationId
    this.syncVoiceOverlay()
    this.broadcast()
  }

  private getStandaloneVoicePosition() {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    return {
      x: display.bounds.x + Math.round(display.bounds.width / 2),
      y: display.bounds.y + display.bounds.height - 88,
    }
  }
}
