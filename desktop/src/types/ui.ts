export type UiMode = 'chat' | 'voice'

export type WindowMode = 'full' | 'mini' | 'voice'

export type ViewType = 'home' | 'store' | 'app' | 'chat'

export type UiState = {
  mode: UiMode
  window: WindowMode
  view: ViewType
  conversationId: string | null
  isVoiceActive: boolean
  isVoiceRtcActive: boolean
}
