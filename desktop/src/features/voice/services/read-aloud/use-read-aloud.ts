/**
 * Watches the chat message stream and, when read-aloud is enabled, plays
 * each newly-finalized assistant message via the TTS service.
 *
 * Threshold model:
 *   - When the toggle flips off→on we record `enabledAtMs = Date.now()`.
 *   - Only assistant messages whose `message.timestamp > enabledAtMs`
 *     are ever spoken. This is robust against (a) the renderer's initial
 *     load — messages arriving after the pref does not retroactively
 *     trigger TTS for the whole history — and (b) navigating between
 *     conversations: an existing conversation's history all has older
 *     timestamps than the toggle's enabled-at moment.
 *
 * Spoken message ids are tracked in a module-level set so the same
 * message isn't requested twice when both the full chat and the sidebar
 * render the same conversation in parallel.
 *
 * Voice-sourced assistant messages (`payload.source === "voice"`) are
 * skipped so the realtime voice agent never gets double-spoken.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MessageRecord } from "../../../../../../runtime/contracts/local-chat.js";
import { stripMarkdownForTts } from "./markdown-strip";
import { fetchReadAloudAudio, type ReadAloudVoiceFamily } from "./tts-client";
import { playReadAloud, stopReadAloud } from "./read-aloud-player";
import { readAloudPrefStore } from "./read-aloud-pref";

const spokenMessageIds = new Set<string>();

type MessagePayload = {
  text?: unknown;
  source?: unknown;
};

const getAssistantText = (message: MessageRecord): string | null => {
  if (message.type !== "assistant_message") return null;
  const payload = (message.payload ?? {}) as MessagePayload;
  if (payload.source === "voice") return null;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  return text;
};

const resolveVoiceFamily = (
  underlying: "openai" | "xai" | "inworld" | undefined,
): ReadAloudVoiceFamily => {
  // xAI has no non-realtime TTS endpoint — fall back to OpenAI voices.
  if (underlying === "inworld") return "inworld";
  return "openai";
};

const readVoicePrefs = async (): Promise<{
  family: ReadAloudVoiceFamily;
  voice?: string;
  speed?: number;
}> => {
  try {
    const prefs = await window.electronAPI?.system?.getLocalModelPreferences?.();
    const rt = prefs?.realtimeVoice;
    if (!rt) return { family: "openai" };
    const underlying =
      rt.provider === "stella"
        ? (rt.stellaSubProvider ?? "openai")
        : rt.provider;
    const family = resolveVoiceFamily(
      underlying as "openai" | "xai" | "inworld",
    );
    const voice = rt.voices?.[family];
    const speed = family === "inworld" ? rt.inworldSpeed : undefined;
    return {
      family,
      voice:
        typeof voice === "string" && voice.trim().length > 0
          ? voice.trim()
          : undefined,
      speed:
        typeof speed === "number" && Number.isFinite(speed) ? speed : undefined,
    };
  } catch {
    return { family: "openai" };
  }
};

export function useReadAloud(messages: readonly MessageRecord[]): void {
  const enabled = useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );
  // Timestamp (ms) the user transitioned into "enabled". Anything
  // older than this is treated as pre-existing history and skipped.
  const enabledAtMsRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      stopReadAloud();
      enabledAtMsRef.current = null;
      return;
    }
    if (enabledAtMsRef.current === null) {
      enabledAtMsRef.current = Date.now();
    }
    const threshold = enabledAtMsRef.current;
    for (const message of messages) {
      if (spokenMessageIds.has(message._id)) continue;
      if (
        typeof message.timestamp !== "number" ||
        message.timestamp <= threshold
      ) {
        continue;
      }
      const text = getAssistantText(message);
      if (text === null) {
        spokenMessageIds.add(message._id);
        continue;
      }
      spokenMessageIds.add(message._id);
      const clean = stripMarkdownForTts(text);
      if (!clean) continue;
      void (async () => {
        try {
          const prefs = await readVoicePrefs();
          if (!enabledRef.current) return;
          const { audio } = await fetchReadAloudAudio({
            text: clean,
            voiceProvider: prefs.family,
            voice: prefs.voice,
            speed: prefs.speed,
          });
          if (!enabledRef.current) return;
          await playReadAloud(audio);
        } catch (err) {
          console.warn("[read-aloud] playback failed:", err);
        }
      })();
    }
  }, [enabled, messages]);
}
