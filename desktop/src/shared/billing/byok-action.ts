/**
 * Shared "Use my own key" toast action — pops the sidebar's model picker
 * popover so the user can flip to a BYOK / OAuth provider (Anthropic,
 * OpenAI, OpenRouter, local runtime, …) without leaving their current
 * surface. The Sidebar listens for `stella:open-model-picker` and
 * controls the popover open state.
 */

export const OPEN_MODEL_PICKER_EVENT = 'stella:open-model-picker'

export const BYOK_TOAST_ACTION = {
  label: 'Use my own key',
  onClick: (): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new Event(OPEN_MODEL_PICKER_EVENT))
  },
} as const
