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
  private voiceActiveListeners = new Set<(active: boolean) => void>()

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

  onVoiceActiveChanged(listener: (active: boolean) => void): () => void {
    this.voiceActiveListeners.add(listener)
    return () => {
      this.voiceActiveListeners.delete(listener)
    }
  }

  private notifyVoiceActive() {
    for (const listener of this.voiceActiveListeners) {
      try {
        listener(this.state.isVoiceRtcActive)
      } catch (error) {
        console.warn('[ui-state] voice listener threw:', error)
      }
    }
  }

  deactivateVoiceModes(): boolean {
    if (!this.state.isVoiceRtcActive) {
      return false
    }
    this.state.isVoiceRtcActive = false
    this.broadcast()
    this.notifyVoiceActive()
    return true
  }

  activateVoiceRtc(conversationId: string | null) {
    const wasActive = this.state.isVoiceRtcActive
    this.state.isVoiceRtcActive = true
    this.state.mode = 'voice'
    this.state.conversationId = conversationId ?? this.state.conversationId
    this.broadcast()
    if (!wasActive) this.notifyVoiceActive()
  }
}
