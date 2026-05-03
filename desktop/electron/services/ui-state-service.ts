import { BrowserWindow } from 'electron'
import type { UiState } from '../types.js'

export type UiStateBroadcastTarget = {
  getAllWindows: () => BrowserWindow[]
}

export type UiStateServiceDeps = {
  broadcastTarget: UiStateBroadcastTarget
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null
}

export class UiStateService {
  readonly state: UiState = {
    mode: 'chat',
    window: 'full',
    conversationId: null,
    isVoiceRtcActive: false,
    suppressNativeRadialDuringOnboarding: false,
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

  deactivateVoiceModes(): boolean {
    if (!this.state.isVoiceRtcActive) {
      return false
    }
    this.state.isVoiceRtcActive = false
    this.broadcast()
    return true
  }

  activateVoiceRtc(conversationId: string | null) {
    this.state.isVoiceRtcActive = true
    this.state.mode = 'voice'
    this.state.conversationId = conversationId ?? this.state.conversationId
    this.broadcast()
  }
}
