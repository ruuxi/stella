import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Auto-prompt scheduler for the anonymous feedback dialog.
 *
 * Goal: nudge a user to leave feedback once per day, but only if they've
 * actually been *using* Stella — not just leaving the window open. We
 * accumulate "active" time (window visible AND focused) into a per-day
 * bucket; once that bucket crosses ~30 minutes and at least 24 hours have
 * passed since the last prompt, the hook flips `shouldPrompt` to true.
 *
 * Persistence is in localStorage so the budget survives reloads / restarts.
 * Acknowledging the prompt resets the day's bucket and stamps `lastPromptAt`
 * so the user gets at most one prompt per 24-hour window.
 */

const STORAGE_KEY_BUCKET_DAY = "stella:feedback:bucketDay";
const STORAGE_KEY_ACTIVE_MS = "stella:feedback:activeMs";
const STORAGE_KEY_LAST_PROMPT_AT = "stella:feedback:lastPromptAt";

const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000;
const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Tick every 30s. Short enough that a 30-minute threshold lands within one
// tick of when it actually crosses; long enough that we're not waking the
// renderer constantly.
const TICK_INTERVAL_MS = 30 * 1000;

const todayBucketKey = (now: number): string => {
  const d = new Date(now);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const safeReadNumber = (key: string): number => {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

const safeReadString = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeWrite = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage can throw in private mode / sandboxed contexts. The
    // prompt is a nicety, not a correctness requirement, so swallow.
  }
};

const isWindowActive = (): boolean => {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) {
    return false;
  }
  return true;
};

export interface FeedbackPromptController {
  shouldPrompt: boolean;
  acknowledge: () => void;
}

export const useFeedbackPrompt = (): FeedbackPromptController => {
  const [shouldPrompt, setShouldPrompt] = useState(false);

  // Tracks the wall-clock at which the current "active" stretch started.
  // Null when the window is currently inactive. We bank elapsed time into
  // localStorage on every state change (visibility/focus flip, tick, unmount).
  const activeSinceRef = useRef<number | null>(null);

  const bankElapsed = useCallback((nowMs: number) => {
    if (activeSinceRef.current === null) return;
    const elapsed = Math.max(0, nowMs - activeSinceRef.current);
    activeSinceRef.current = nowMs;
    if (elapsed === 0) return;

    const bucketKey = todayBucketKey(nowMs);
    const storedKey = safeReadString(STORAGE_KEY_BUCKET_DAY);
    const prior =
      storedKey === bucketKey ? safeReadNumber(STORAGE_KEY_ACTIVE_MS) : 0;
    const next = prior + elapsed;
    safeWrite(STORAGE_KEY_BUCKET_DAY, bucketKey);
    safeWrite(STORAGE_KEY_ACTIVE_MS, String(next));
  }, []);

  const evaluatePrompt = useCallback((nowMs: number) => {
    const bucketKey = todayBucketKey(nowMs);
    const storedKey = safeReadString(STORAGE_KEY_BUCKET_DAY);
    const activeMs =
      storedKey === bucketKey ? safeReadNumber(STORAGE_KEY_ACTIVE_MS) : 0;
    if (activeMs < ACTIVE_THRESHOLD_MS) {
      setShouldPrompt(false);
      return;
    }
    const lastPromptAt = safeReadNumber(STORAGE_KEY_LAST_PROMPT_AT);
    if (nowMs - lastPromptAt < PROMPT_COOLDOWN_MS) {
      setShouldPrompt(false);
      return;
    }
    setShouldPrompt(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (isWindowActive()) {
      activeSinceRef.current = Date.now();
    }
    evaluatePrompt(Date.now());

    const handleActivityChange = () => {
      const now = Date.now();
      bankElapsed(now);
      if (isWindowActive()) {
        if (activeSinceRef.current === null) {
          activeSinceRef.current = now;
        }
      } else {
        activeSinceRef.current = null;
      }
      evaluatePrompt(now);
    };

    const interval = window.setInterval(() => {
      const now = Date.now();
      bankElapsed(now);
      evaluatePrompt(now);
    }, TICK_INTERVAL_MS);

    document.addEventListener("visibilitychange", handleActivityChange);
    window.addEventListener("focus", handleActivityChange);
    window.addEventListener("blur", handleActivityChange);
    window.addEventListener("pagehide", handleActivityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleActivityChange);
      window.removeEventListener("focus", handleActivityChange);
      window.removeEventListener("blur", handleActivityChange);
      window.removeEventListener("pagehide", handleActivityChange);
      // Bank one last time on unmount so a quick reload doesn't lose the
      // current active stretch.
      bankElapsed(Date.now());
      activeSinceRef.current = null;
    };
  }, [bankElapsed, evaluatePrompt]);

  const acknowledge = useCallback(() => {
    const now = Date.now();
    safeWrite(STORAGE_KEY_LAST_PROMPT_AT, String(now));
    safeWrite(STORAGE_KEY_BUCKET_DAY, todayBucketKey(now));
    safeWrite(STORAGE_KEY_ACTIVE_MS, "0");
    if (activeSinceRef.current !== null) {
      activeSinceRef.current = now;
    }
    setShouldPrompt(false);
  }, []);

  return { shouldPrompt, acknowledge };
};
