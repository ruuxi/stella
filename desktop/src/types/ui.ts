export type UiMode = 'ask' | 'chat' | 'voice'

export type WindowMode = 'full' | 'mini'

export type UiPanelState = {
  isOpen: boolean
  width: number
  focused: boolean
  activeScreenId: string
  chatDrawerOpen: boolean
}

export type UiState = {
  mode: UiMode
  window: WindowMode
  conversationId: string | null
  panel: UiPanelState
}

export type UiStateUpdate = Partial<Omit<UiState, 'panel'>> & {
  panel?: Partial<UiPanelState>
}
