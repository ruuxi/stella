/**
 * Cross-process types for the local model preferences surface.
 *
 * The renderer (`electron.d.ts`, `preload.ts`, model picker UI) and the
 * kernel (`runtime/kernel/preferences/local-preferences.ts`) both need to
 * agree on the shape of voice preferences without each side inlining its
 * own copy of the literal.
 *
 * Pure types + pure-function resolvers only — no fs/path imports here,
 * since this module is reachable from preload + renderer bundles.
 */

export type RealtimeVoiceProvider = "stella" | "openai" | "xai" | "inworld";

/**
 * Subset of the providers that can actually mint a voice — Stella mode
 * routes through one of these under the hood (`stellaSubProvider`).
 */
export type RealtimeVoiceUnderlyingProvider = "openai" | "xai" | "inworld";

/**
 * Per-underlying-provider voice id selection. Stored per provider (rather
 * than as a single flat field) so that switching between providers
 * preserves each one's choice — e.g. picking "rex" under xAI doesn't get
 * silently rewritten to "marin" when the user flips back to OpenAI.
 */
export type RealtimeVoiceSelections = {
  openai?: string;
  xai?: string;
  inworld?: string;
};

export type RealtimeVoicePreferences = {
  provider: RealtimeVoiceProvider;
  model?: string;
  voices?: RealtimeVoiceSelections;
  /**
   * Active voice family when `provider === "stella"`. Lets the user pick
   * an OpenAI, xAI, or Inworld voice while still routing through Stella's
   * managed backend (no BYOK). Ignored for BYOK modes — those are pinned
   * to their own family.
   */
  stellaSubProvider?: RealtimeVoiceUnderlyingProvider;
  /**
   * Inworld TTS playback speed multiplier. Inworld accepts ~0.5–2.0 on
   * `audio.output.speed`. Only applies to Inworld voices.
   */
  inworldSpeed?: number;
};

/**
 * Resolve which underlying voice family the session should use. For
 * BYOK modes (openai/xai/inworld) this is pinned. For Stella mode it
 * follows `stellaSubProvider`, defaulting to "openai".
 */
export const resolveRealtimeUnderlyingProvider = (
  prefs: Pick<RealtimeVoicePreferences, "provider" | "stellaSubProvider">,
): RealtimeVoiceUnderlyingProvider => {
  if (prefs.provider === "xai") return "xai";
  if (prefs.provider === "openai") return "openai";
  if (prefs.provider === "inworld") return "inworld";
  if (prefs.stellaSubProvider === "xai") return "xai";
  if (prefs.stellaSubProvider === "inworld") return "inworld";
  return "openai";
};

const REALTIME_VOICE_PROVIDERS: readonly RealtimeVoiceProvider[] = [
  "stella",
  "openai",
  "xai",
  "inworld",
];

/** Narrow an arbitrary string to a RealtimeVoiceProvider, defaulting to "stella". */
export const coerceRealtimeVoiceProvider = (
  value: string,
): RealtimeVoiceProvider =>
  (REALTIME_VOICE_PROVIDERS as readonly string[]).includes(value)
    ? (value as RealtimeVoiceProvider)
    : "stella";
