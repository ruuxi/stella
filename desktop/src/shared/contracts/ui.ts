export type UiMode = 'chat' | 'voice'

export type WindowMode = 'full' | 'mini'

export type ViewType = string

export type UiState = {
  mode: UiMode
  window: WindowMode
  view: ViewType
  conversationId: string | null
  isVoiceActive: boolean
  isVoiceRtcActive: boolean
}
