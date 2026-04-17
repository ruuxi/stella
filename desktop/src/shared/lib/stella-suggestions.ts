import type { SuggestionChip } from "@/app/chat/hooks/use-auto-context-chips";

/**
 * Window-level event dispatched when a one-shot suggestion should appear in
 * the chat sidebar's auto-context chip strip — e.g. cmd+right-click → "Open
 * chat" surfaces the right-clicked window as a clickable chip even if it
 * isn't the frontmost app at the moment the sidebar opens.
 *
 * The suggestion-context row hook (`useAutoContextChips`) listens for this
 * event and pins the chip into the next available slot. The chip rides
 * through the same fade-in / fade-out lifecycle as poll-derived chips.
 */
export const STELLA_PIN_SUGGESTION_EVENT = "stella:pin-suggestion";

export type StellaPinSuggestionDetail = {
  chip: SuggestionChip;
};

export function dispatchStellaPinSuggestion(detail: StellaPinSuggestionDetail) {
  window.dispatchEvent(
    new CustomEvent<StellaPinSuggestionDetail>(STELLA_PIN_SUGGESTION_EVENT, {
      detail,
    }),
  );
}
