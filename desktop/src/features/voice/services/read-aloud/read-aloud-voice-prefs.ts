/**
 * Resolves the read-aloud voice family / voice / speed from the user's
 * stored local model preferences.
 *
 * Shared by the auto-read-aloud subscriber (`use-read-aloud.ts`) and the
 * on-demand per-message read-aloud action (`manual-read-aloud.ts`) so both
 * speak with the exact same voice the user picked.
 */
import { resolveReadAloudProvider } from "../../../../../../runtime/contracts/local-preferences.js";
import { getDefaultRealtimeVoice } from "../../../../../../runtime/contracts/realtime-voice-catalog.js";
import type { ReadAloudVoiceFamily } from "./tts-client";

export type ReadAloudVoicePrefs = {
  family: ReadAloudVoiceFamily;
  voice?: string;
  speed?: number;
};

export const resolveReadAloudVoicePrefs =
  async (): Promise<ReadAloudVoicePrefs> => {
    try {
      const prefs =
        await window.electronAPI?.system?.getLocalModelPreferences?.();
      const rt = prefs?.realtimeVoice;
      // Read-aloud is controlled by its own switch. Selecting a realtime
      // voice provider should not silently change read-aloud; unset defaults
      // to Inworld.
      const family: ReadAloudVoiceFamily = resolveReadAloudProvider({
        readAloudProvider: rt?.readAloudProvider,
      });
      const stored = rt?.voices?.[family];
      // Fall back to the catalog default (e.g. Olivia for Inworld) rather
      // than letting the backend pick its own default voice.
      const voice =
        typeof stored === "string" && stored.trim().length > 0
          ? stored.trim()
          : getDefaultRealtimeVoice(family);
      const speed = family === "inworld" ? rt?.inworldSpeed : undefined;
      return {
        family,
        voice,
        speed:
          typeof speed === "number" && Number.isFinite(speed)
            ? speed
            : undefined,
      };
    } catch {
      return { family: "inworld" };
    }
  };
