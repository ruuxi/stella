/**
 * useDictation — wires an InworldDictationSession to the composer textarea.
 *
 * Flow:
 *   - First toggle: start recording. The composer swaps in a recording
 *     bar (waveform + timer + cancel/confirm) driven by the `levels`,
 *     `elapsedMs`, and `cancel` values returned here.
 *   - Confirm (or Cmd/Ctrl+Shift+M): stop. We upload the captured audio
 *     as a single WAV to `/api/dictation/transcribe`, then append the
 *     returned transcript to whatever the composer text was at the
 *     moment we started recording.
 *   - Cancel (X): tear down without uploading or appending anything.
 *
 * The global Cmd/Ctrl+Shift+M keybind dispatches a window event the
 * hook listens for, so any composer with `useDictation` mounted toggles
 * itself when the user is on its window.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  InworldDictationSession,
  type DictationSessionState,
} from "@/features/dictation/services/inworld-dictation";

export const DICTATION_TOGGLE_EVENT = "stella:dictation-toggle";

/** How many waveform bars we retain. The session emits ~12.5 ticks/sec, so
 *  this buffers ~20 s of recent activity before older bars scroll off. */
const MAX_LEVEL_BARS = 256;

type Setter<T> = (next: T | ((prev: T) => T)) => void;

interface UseDictationOptions {
  setMessage: Setter<string>;
  message: string;
  disabled?: boolean;
  onError?: (error: string) => void;
}

interface UseDictationResult {
  isRecording: boolean;
  isTranscribing: boolean;
  state: DictationSessionState;
  /** Toggle recording: start → stop+transcribe (or stop+transcribe → start). */
  toggle: () => void;
  /** Stop recording without uploading or appending anything. */
  cancel: () => void;
  /** Rolling buffer of recent input levels in 0..1, oldest first. */
  levels: number[];
  /** Elapsed time of the current recording, in milliseconds. */
  elapsedMs: number;
  error: string | null;
}

const joinTranscriptOntoBase = (base: string, transcript: string): string => {
  if (!transcript) return base;
  if (!base) return transcript;
  const trimmedBase = base.replace(/\s+$/, "");
  return `${trimmedBase} ${transcript}`;
};

export const useDictation = ({
  setMessage,
  message,
  disabled = false,
  onError,
}: UseDictationOptions): UseDictationResult => {
  const [state, setState] = useState<DictationSessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);

  const sessionRef = useRef<InworldDictationSession | null>(null);
  const baseTextRef = useRef("");
  const messageRef = useRef(message);
  const setMessageRef = useRef(setMessage);
  const onErrorRef = useRef(onError);
  const stateRef = useRef<DictationSessionState>("idle");

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  useEffect(() => {
    setMessageRef.current = setMessage;
  }, [setMessage]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // While listening, tick a 4-Hz timer for the visible mm:ss display.
  // The initial 0:00 paint is set in `start()` before the session begins
  // so this effect only owns the running interval, not the reset.
  useEffect(() => {
    if (state !== "listening") return;
    const startedAt = performance.now();
    const id = setInterval(() => {
      setElapsedMs(performance.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await session.stop();
    } catch (err) {
      console.debug("[dictation] stop failed:", (err as Error).message);
    }
  }, []);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    setLevels([]);
    void session.cancel().catch((err: Error) => {
      console.debug("[dictation] cancel failed:", err.message);
    });
  }, []);

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    if (disabled) return;
    const session = new InworldDictationSession();
    sessionRef.current = session;
    baseTextRef.current = messageRef.current;
    setError(null);
    setLevels([]);
    setElapsedMs(0);

    try {
      await session.start({
        onStateChange: (next, errMessage) => {
          setState(next);
          if (next === "error" && errMessage) {
            console.warn("[dictation] session entered error state:", errMessage);
            setError(errMessage);
            onErrorRef.current?.(errMessage);
          }
          if (next === "idle" || next === "error") {
            sessionRef.current = null;
            setLevels([]);
          }
        },
        onFinalTranscript: (transcript) => {
          const next = joinTranscriptOntoBase(baseTextRef.current, transcript);
          setMessageRef.current(next);
        },
        onLevel: (level) => {
          setLevels((prev) => {
            if (prev.length < MAX_LEVEL_BARS) {
              return [...prev, level];
            }
            // Rolling buffer — drop oldest, append newest.
            const next = prev.slice(prev.length - MAX_LEVEL_BARS + 1);
            next.push(level);
            return next;
          });
        },
      });
    } catch (err) {
      const errMessage = (err as Error).message;
      setError(errMessage);
      onErrorRef.current?.(errMessage);
      sessionRef.current = null;
      setLevels([]);
    }
  }, [disabled]);

  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current === "listening") {
      void stop();
    } else if (current === "transcribing") {
      // Upload in flight — ignore presses until it resolves.
      return;
    } else {
      void start();
    }
  }, [start, stop]);

  useEffect(() => {
    const handler = () => toggle();
    window.addEventListener(DICTATION_TOGGLE_EVENT, handler);
    return () => window.removeEventListener(DICTATION_TOGGLE_EVENT, handler);
  }, [toggle]);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session) {
        void session.cancel().catch(() => undefined);
        sessionRef.current = null;
      }
    };
  }, []);

  return {
    isRecording: state === "listening",
    isTranscribing: state === "transcribing",
    state,
    toggle,
    cancel,
    levels,
    elapsedMs,
    error,
  };
};
