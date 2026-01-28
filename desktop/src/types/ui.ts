export type UiMode = 'ask' | 'chat' | 'voice'

export type WindowMode = 'full' | 'mini'

export type UiState = {
  mode: UiMode
  window: WindowMode
  conversationId: string | null
}
