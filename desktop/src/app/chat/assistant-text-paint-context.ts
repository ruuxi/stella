import { createContext, useContext } from "react";

/**
 * Bridges the streaming assistant row's *visible* paint moment up to the
 * working-indicator lifecycle.
 *
 * The inline working indicator must stay up until the first assistant
 * character is actually painted on screen — not merely until the first
 * delta arrives in the data stream. There's a real window between the two:
 * a delta arrives, but the paced reveal / Streamdown first-render / mask
 * frontier delay painting it. Dismissing on data arrival leaves a dead gap
 * where neither the indicator nor any text is visible.
 *
 * `StreamingTextReveal` lives deep inside the virtualized timeline while
 * the indicator's `active` state is derived up in the streaming hook, so a
 * context carries the one-shot "the reveal frontier has begun painting"
 * signal across that gap. The default is a no-op so the reveal renders
 * fine without a provider (other surfaces, tests).
 */
export type NotifyAssistantTextPainted = () => void;

const noop: NotifyAssistantTextPainted = () => {};

export const AssistantTextPaintContext =
  createContext<NotifyAssistantTextPainted>(noop);

/** The reveal calls this once it first paints visible characters. */
export const useNotifyAssistantTextPainted = (): NotifyAssistantTextPainted =>
  useContext(AssistantTextPaintContext);
