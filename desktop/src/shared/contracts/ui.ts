export type UiMode = 'chat' | 'voice'

export type WindowMode = 'full' | 'mini'

export type ViewType = 'app' | 'chat' | 'store' | 'social'

export type UiState = {
  mode: UiMode
  window: WindowMode
  view: ViewType
  conversationId: string | null
  isVoiceRtcActive: boolean
  suppressNativeRadialDuringOnboarding: boolean
}
