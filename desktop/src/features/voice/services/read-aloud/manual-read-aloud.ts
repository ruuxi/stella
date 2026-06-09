/**
 * On-demand ("read aloud this message") TTS, driven by the per-message
 * volume button in the chat. Distinct from `use-read-aloud.ts`, which
 * automatically speaks every finalized assistant reply while the global
 * toggle is on.
 *
 * One message plays at a time: starting a new one (or re-clicking the
 * active one) cancels the current playback. State is held in a module
 * store so the action bars across the full chat and the sidebar reflect
 * the same playing/loading status, and an incrementing request token
 * discards audio that finishes fetching after the user moved on.
 */
import { useSyncExternalStore } from "react";
import { stripMarkdownForTts } from "./markdown-strip";
import { fetchReadAloudAudio } from "./tts-client";
import { playReadAloud, stopReadAloud } from "./read-aloud-player";
import { resolveReadAloudVoicePrefs } from "./read-aloud-voice-prefs";

export type ManualReadAloudStatus = "idle" | "loading" | "playing";

type ManualReadAloudState = {
  /** The message key currently loading/playing, or null when idle. */
  key: string | null;
  status: ManualReadAloudStatus;
};

const IDLE_STATE: ManualReadAloudState = { key: null, status: "idle" };

let state: ManualReadAloudState = IDLE_STATE;
let requestToken = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const setState = (next: ManualReadAloudState) => {
  if (next.key === state.key && next.status === state.status) return;
  state = next;
  emit();
};

const goIdle = () => setState(IDLE_STATE);

/**
 * Toggle on-demand read-aloud for a message. Clicking the active
 * message stops it; clicking a different one interrupts the previous
 * and speaks the new text.
 */
export async function toggleManualReadAloud(
  key: string,
  text: string,
): Promise<void> {
  // Re-click on the active message → stop.
  if (state.key === key && state.status !== "idle") {
    requestToken += 1;
    stopReadAloud();
    goIdle();
    return;
  }

  const token = ++requestToken;
  stopReadAloud();

  const clean = stripMarkdownForTts(text);
  if (!clean) {
    goIdle();
    return;
  }

  setState({ key, status: "loading" });
  try {
    const prefs = await resolveReadAloudVoicePrefs();
    if (token !== requestToken) return;
    const { audio } = await fetchReadAloudAudio({
      text: clean,
      voiceProvider: prefs.family,
      voice: prefs.voice,
      speed: prefs.speed,
    });
    if (token !== requestToken) return;
    setState({ key, status: "playing" });
    await playReadAloud(audio, {
      onEnded: () => {
        if (token === requestToken) goIdle();
      },
    });
  } catch (err) {
    console.warn("[manual-read-aloud] playback failed:", err);
    if (token === requestToken) goIdle();
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): ManualReadAloudState => state;

/** Status of on-demand read-aloud for a specific message key. */
export function useManualReadAloudStatus(key: string): ManualReadAloudStatus {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snapshot.key === key ? snapshot.status : "idle";
}
