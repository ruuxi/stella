/**
 * Voice catalogs for the realtime voice providers Stella supports.
 *
 * Lives in `contracts/` because both:
 *   - the main process (ipc/voice-handlers.ts) needs to validate the
 *     user-selected voice before passing it to the ephemeral-token mint, and
 *   - the renderer (settings UI + provider modules) needs to render the
 *     picker rows.
 *
 * The catalogs are the source-of-truth list of *known* voices, but voice
 * IDs are passed through to the provider as opaque strings — that lets
 * xAI's custom-voice IDs (cloned from a reference clip) work without
 * changes here.
 */

export type { RealtimeVoiceUnderlyingProvider } from "./local-preferences.js";
import type { RealtimeVoiceUnderlyingProvider } from "./local-preferences.js";

export interface RealtimeVoiceCatalogEntry {
  /** Voice id passed to the provider verbatim. */
  id: string;
  /** Short user-visible name. */
  label: string;
  /** One-line tone/description shown under the label. */
  description: string;
}

/**
 * OpenAI Realtime voices (used by the OpenAI BYOK path AND by the
 * Stella-managed path, which mints OpenAI realtime tokens server-side).
 */
export const OPENAI_REALTIME_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  {
    id: "marin",
    label: "Marin",
    description: "Warm, natural — the default Realtime voice.",
  },
  { id: "alloy", label: "Alloy", description: "Balanced and neutral." },
  { id: "ash", label: "Ash", description: "Soft, breathy." },
  { id: "ballad", label: "Ballad", description: "Calm and measured." },
  { id: "coral", label: "Coral", description: "Bright and friendly." },
  { id: "echo", label: "Echo", description: "Crisp and clear." },
  { id: "sage", label: "Sage", description: "Thoughtful and steady." },
  { id: "shimmer", label: "Shimmer", description: "Upbeat and energetic." },
  { id: "verse", label: "Verse", description: "Smooth and lyrical." },
];

/**
 * xAI Grok Voice Agent voices. The model also accepts custom voice IDs
 * cloned from a reference clip via xAI's Custom Voices API.
 */
export const XAI_REALTIME_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  { id: "eve", label: "Eve", description: "Energetic and upbeat (default)." },
  { id: "ara", label: "Ara", description: "Warm and friendly." },
  {
    id: "rex",
    label: "Rex",
    description: "Confident and articulate — good for business.",
  },
  { id: "sal", label: "Sal", description: "Smooth and balanced." },
  {
    id: "leo",
    label: "Leo",
    description: "Authoritative — good for instructional content.",
  },
];

/**
 * Inworld Realtime voice catalog — the curated set of voices available
 * on the Stella org's Inworld account. Steerable voices can be tuned
 * further via session config; non-steerable voices play as-is.
 *
 * Custom/cloned voice IDs from a user's own Inworld account also work
 * via the BYOK Inworld path — the voice id is passed through as an
 * opaque string. To add or remove default voices, edit this list.
 */
export const INWORLD_REALTIME_VOICES: readonly RealtimeVoiceCatalogEntry[] = [
  { id: "Clive", label: "Clive", description: "English male, middle-aged (default)." },
  { id: "Ashley", label: "Ashley", description: "English female, middle-aged." },
  { id: "Blake", label: "Blake", description: "English male, middle-aged." },
  { id: "Eleanor", label: "Eleanor", description: "English female, middle-aged." },
  { id: "Hades", label: "Hades", description: "English male, middle-aged, deeper tone." },
  { id: "Hana", label: "Hana", description: "English female, young." },
  { id: "Jason", label: "Jason", description: "English male, middle-aged." },
  { id: "Luna", label: "Luna", description: "English female, middle-aged. Steerable." },
  { id: "Mark", label: "Mark", description: "English male, middle-aged." },
  { id: "Olivia", label: "Olivia", description: "English female, middle-aged." },
  { id: "Reed", label: "Reed", description: "English male, middle-aged." },
  { id: "Sarah", label: "Sarah", description: "English female, middle-aged. Steerable." },
  { id: "Sophie", label: "Sophie", description: "English female, middle-aged." },
  { id: "Theodore", label: "Theodore", description: "English male, older." },
];

/** Default Inworld LLM router model id. Must match `provider/modelName`. */
export const DEFAULT_INWORLD_REALTIME_MODEL = "xai/grok-4.3-latest";
/** Default Inworld TTS model id. `inworld-tts-2` is their 8B higher-quality model. */
export const DEFAULT_INWORLD_REALTIME_TTS_MODEL = "inworld-tts-2";
/**
 * Inworld TTS playback speed multiplier. 1.0 is real-time; >1 is faster.
 * Inworld accepts roughly 0.5–2.0 on `audio.output.speed`. 1.15 is a
 * subtle bump that feels noticeably snappier without sounding cartoonish.
 */
export const DEFAULT_INWORLD_REALTIME_SPEED = 1.15;

export const DEFAULT_OPENAI_REALTIME_VOICE = "marin";
export const DEFAULT_XAI_REALTIME_VOICE = "eve";
export const DEFAULT_INWORLD_REALTIME_VOICE = "Clive";

export function getDefaultRealtimeVoice(
  provider: RealtimeVoiceUnderlyingProvider,
): string {
  if (provider === "xai") return DEFAULT_XAI_REALTIME_VOICE;
  if (provider === "inworld") return DEFAULT_INWORLD_REALTIME_VOICE;
  return DEFAULT_OPENAI_REALTIME_VOICE;
}

export function getRealtimeVoiceCatalog(
  provider: RealtimeVoiceUnderlyingProvider,
): readonly RealtimeVoiceCatalogEntry[] {
  if (provider === "xai") return XAI_REALTIME_VOICES;
  if (provider === "inworld") return INWORLD_REALTIME_VOICES;
  return OPENAI_REALTIME_VOICES;
}
