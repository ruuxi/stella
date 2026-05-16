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
  ensureDictationSuperFastWarm,
  InworldDictationSession,
  isDictationSuperFastEnabled,
  warmLocalDictationModel,
  type DictationSessionState,
} from "@/features/dictation/services/inworld-dictation";
import { appendRollingLevel } from "@/features/dictation/rolling-levels";
import { getClaimedDictationComposer } from "@/features/dictation/active-composer";

export const DICTATION_TOGGLE_EVENT = "stella:dictation-toggle";

type DictationToggleEventDetail = {
  startId?: string;
  action?: "toggle" | "start" | "reveal" | "stop" | "cancel";
};

/** How many waveform bars we retain. The session emits ~12.5 ticks/sec, so
 *  this buffers ~20 s of recent activity before older bars scroll off. */
const MAX_LEVEL_BARS = 256;

type Setter<T> = (next: T | ((prev: T) => T)) => void;

interface UseDictationOptions {
  setMessage: Setter<string>;
  message: string;
  disabled?: boolean;
  onError?: (error: string) => void;
  onTranscriptCommitted?: () => void;
  /**
   * Invoked when `commitAndSend` finishes — i.e. the recording has stopped,
   * any pending transcription has been appended to the composer message, and
   * the caller should now submit the composer. Reads the latest `setMessage`
   * via ref so it always sees the post-transcript value.
   */
  onCommit?: () => void;
  /**
   * Optional claim id, used to multiplex dictation between the default
   * chat composer (no `claimId`) and secondary composers (the Store
   * side-panel composer, etc.). See `active-composer.ts` for the rule —
   * a hook with a `claimId` only responds to toggle events when it
   * currently holds the claim; a hook without one only responds when
   * nobody holds it.
   */
  claimId?: string;
}

interface UseDictationResult {
  isRecording: boolean;
  isRecordingVisible: boolean;
  isTranscribing: boolean;
  showControls: boolean;
  state: DictationSessionState;
  /** Toggle recording: start → stop+transcribe (or stop+transcribe → start). */
  toggle: () => void;
  /** Stop recording without uploading or appending anything. */
  cancel: () => void;
  /**
   * Stop, transcribe (if necessary), and then fire `onCommit`. Used by the
   * composer's send-arrow affordance so the user can dictate-and-submit in a
   * single tap.
   */
  commitAndSend: () => void;
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
  onTranscriptCommitted,
  onCommit,
  claimId,
}: UseDictationOptions): UseDictationResult => {
  const [state, setState] = useState<DictationSessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [showRecordingBar, setShowRecordingBar] = useState(false);

  const sessionRef = useRef<InworldDictationSession | null>(null);
  const baseTextRef = useRef("");
  const messageRef = useRef(message);
  const setMessageRef = useRef(setMessage);
  const onErrorRef = useRef(onError);
  const onTranscriptCommittedRef = useRef(onTranscriptCommitted);
  const onCommitRef = useRef(onCommit);
  const stateRef = useRef<DictationSessionState>("idle");
  /**
   * When true, the next time we land on idle (whether after a successful
   * transcription or a no-audio short-circuit), we should fire `onCommit`.
   * Cleared every time we either fire it or transition out of idle for a
   * new recording.
   */
  const sendAfterCommitRef = useRef(false);

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
    onTranscriptCommittedRef.current = onTranscriptCommitted;
  }, [onTranscriptCommitted]);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const fireCommitIfPending = useCallback(() => {
    if (!sendAfterCommitRef.current) return;
    sendAfterCommitRef.current = false;
    // Defer one frame so the parent re-renders with the appended transcript
    // before its `onSend` closure reads `message` to submit.
    requestAnimationFrame(() => {
      onCommitRef.current?.();
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    void warmLocalDictationModel().catch(() => undefined);
    if (!isDictationSuperFastEnabled()) return;
    void ensureDictationSuperFastWarm().catch(() => undefined);
  }, []);

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
    sendAfterCommitRef.current = false;
    const session = sessionRef.current;
    if (!session) return;
    setLevels([]);
    setShowControls(false);
    setShowRecordingBar(false);
    void session.cancel().catch((err: Error) => {
      console.debug("[dictation] cancel failed:", err.message);
    });
  }, []);

  const start = useCallback(async (source: "button" | "shortcut") => {
    if (sessionRef.current) return;
    if (disabled) return;
    const session = new InworldDictationSession();
    sessionRef.current = session;
    baseTextRef.current = messageRef.current;
    setError(null);
    setLevels([]);
    setElapsedMs(0);
    setShowControls(source === "button");
    setShowRecordingBar(source === "button");

    try {
      await session.start({
        onStateChange: (next, errMessage) => {
          setState(next);
          window.electronAPI?.dictation?.activeChanged({
            active: next === "listening" || next === "transcribing",
          });
          if (next === "error" && errMessage) {
            console.warn(
              "[dictation] session entered error state:",
              errMessage,
            );
            setError(errMessage);
            onErrorRef.current?.(errMessage);
          }
          if (next === "idle" || next === "error") {
            sessionRef.current = null;
            setLevels([]);
            setShowControls(false);
            setShowRecordingBar(false);
            // For success paths the inworld session emits `idle` before
            // `onFinalTranscript`; defer to a microtask so commit fires
            // after the transcript has been appended. For no-audio /
            // error paths, no transcript ever arrives so we still fire.
            queueMicrotask(fireCommitIfPending);
          }
        },
        onFinalTranscript: (transcript) => {
          const next = joinTranscriptOntoBase(baseTextRef.current, transcript);
          setMessageRef.current(next);
          onTranscriptCommittedRef.current?.();
        },
        onLevel: (level) => {
          setLevels((prev) => appendRollingLevel(prev, level, MAX_LEVEL_BARS));
        },
      });
    } catch (err) {
      const errMessage = (err as Error).message;
      setError(errMessage);
      onErrorRef.current?.(errMessage);
      window.electronAPI?.dictation?.activeChanged({ active: false });
      sessionRef.current = null;
      setLevels([]);
      setShowControls(false);
      setShowRecordingBar(false);
    }
  }, [disabled]);

  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current === "listening") {
      sendAfterCommitRef.current = false;
      window.electronAPI?.dictation?.playSound({ sound: "stopRecording" });
      void stop();
    } else if (current === "transcribing") {
      // Upload in flight — ignore presses until it resolves.
      return;
    } else {
      sendAfterCommitRef.current = false;
      window.electronAPI?.dictation?.playSound({ sound: "startRecording" });
      void start("button");
    }
  }, [start, stop]);

  const commitAndSend = useCallback(() => {
    const current = stateRef.current;
    if (current === "listening") {
      sendAfterCommitRef.current = true;
      void stop();
      return;
    }
    if (current === "transcribing") {
      sendAfterCommitRef.current = true;
      return;
    }
    // Already idle (or in an error state with no live session) — fire the
    // commit immediately; the parent will submit whatever is in the
    // composer right now.
    onCommitRef.current?.();
  }, [stop]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DictationToggleEventDetail>).detail;
      const startId = detail?.startId;
      const action = detail?.action ?? "toggle";
      const current = stateRef.current;
      const canHandle =
        !disabled || current === "listening" || current === "transcribing";
      if (!canHandle) return;
      // Composer multiplexing: a secondary composer (e.g. Store side
      // panel) claims dictation while its textarea is focused. The
      // default chat composer (no `claimId`) gets the event only when
      // nobody holds the claim. The claiming composer only responds
      // while it holds the claim. While `listening`/`transcribing` we
      // always finish on the SAME hook that started — otherwise a
      // late blur would orphan the recording.
      const claimedComposer = getClaimedDictationComposer();
      const inFlight = current === "listening" || current === "transcribing";
      if (!inFlight) {
        if (claimId) {
          if (claimedComposer !== claimId) return;
        } else if (claimedComposer !== null) {
          return;
        }
      }
      window.electronAPI?.dictation?.inAppStarted({ startId });
      if (action === "start") {
        if (current !== "listening" && current !== "transcribing") {
          void start("shortcut");
        }
        return;
      }
      if (action === "reveal") {
        if (current === "listening") {
          setShowRecordingBar(true);
        }
        return;
      }
      if (action === "stop") {
        if (current === "listening") {
          sendAfterCommitRef.current = false;
          void stop();
        }
        return;
      }
      if (action === "cancel") {
        if (current === "listening" || current === "transcribing") {
          cancel();
        }
        return;
      }
      if (current === "listening") {
        sendAfterCommitRef.current = false;
        void stop();
      } else if (current !== "transcribing") {
        sendAfterCommitRef.current = false;
        void start("shortcut");
      }
    };
    window.addEventListener(DICTATION_TOGGLE_EVENT, handler);
    return () => window.removeEventListener(DICTATION_TOGGLE_EVENT, handler);
  }, [cancel, claimId, disabled, start, stop]);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session) {
        window.electronAPI?.dictation?.activeChanged({ active: false });
        void session.cancel().catch(() => undefined);
        sessionRef.current = null;
      }
    };
  }, []);

  return {
    isRecording: state === "listening",
    isRecordingVisible: state === "listening" && showRecordingBar,
    isTranscribing: state === "transcribing",
    showControls,
    state,
    toggle,
    cancel,
    commitAndSend,
    levels,
    elapsedMs,
    error,
  };
};
