/**
 * Per-conversation tracker that surfaces a small "updated" dot on a footer
 * category pill when its options have changed since the user last opened
 * that pill's dropup.
 *
 * Why a content signature (not a timestamp): the LLM-driven home-suggestions
 * refresh (`runtime/kernel/agent-runtime/home-suggestions-refresh.ts`)
 * appends a single new `home_suggestions` event covering all categories,
 * but the model is allowed to change only some of them. Comparing per-
 * category content avoids flagging categories whose options didn't actually
 * change in this refresh.
 *
 * Storage shape (single localStorage key per conversation):
 *
 *   stella.home.ideasSeen.<conversationId> = { [categoryLabel]: <hash> }
 *
 * On first encounter for a category we silently seed the current hash so
 * the dot only ever appears after a real refresh diverges from the seeded
 * baseline. Marking seen happens the moment the dropup opens (not on
 * option select) — opening counts as "I saw it."
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_PREFIX = "stella.home.ideasSeen.";

type Stored = Record<string, string>;

type CategoryShape = {
  label: string;
  options: ReadonlyArray<{ label: string; prompt: string }>;
};

const safeRead = (key: string): Stored => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Stored = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

const safeWrite = (key: string, value: Stored): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort; the dot is purely a UX nudge.
  }
};

/**
 * Stable, cheap content hash. FNV-1a 32-bit on the joined `label|prompt`
 * lines. Collisions are fine — false negatives just hide a dot once.
 */
const hashOptions = (options: CategoryShape["options"]): string => {
  let h = 0x811c9dc5;
  for (const option of options) {
    const s = `${option.label}\u0001${option.prompt}\u0002`;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
};

export function useIdeasSeen(
  conversationId: string | null,
  categories: ReadonlyArray<CategoryShape>,
  /**
   * `true` once `categories` reflects the personalized set (or a
   * confirmed fallback to defaults). While `false` we suppress dot
   * rendering and skip seeding so an interim default-categories render
   * never gets baked into localStorage as the baseline.
   */
  ready: boolean,
): {
  isUnseen: (label: string) => boolean;
  markSeen: (label: string) => void;
} {
  const storageKey = conversationId ? `${STORAGE_PREFIX}${conversationId}` : null;
  // Initialize synchronously from disk so the very first render already
  // has the prior "seen" hashes — otherwise the seeding effect closes
  // over an empty `{}` and overwrites the user's saved acks on remount.
  const [stored, setStored] = useState<Stored>(() =>
    storageKey ? safeRead(storageKey) : {},
  );

  // Re-read on conversation switch so per-conversation state stays isolated.
  useEffect(() => {
    setStored(storageKey ? safeRead(storageKey) : {});
  }, [storageKey]);

  // Compute current hashes for all categories. Memoized off the raw options
  // arrays; the hook re-runs whenever `usePersonalizedCategories` returns a
  // new categories array (which happens on every `home_suggestions` write).
  const currentHashes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const category of categories) {
      map[category.label] = hashOptions(category.options);
    }
    return map;
  }, [categories]);

  // Silent seeding: only fill in baselines for labels we've never seen
  // before. Functional `setStored` so we always merge into the freshest
  // state — using the closed-over `stored` here was the bug that wiped
  // user acks on remount. Skipped while `!ready` so an interim defaults
  // render doesn't lock in the wrong baseline before personalized
  // categories arrive.
  useEffect(() => {
    if (!storageKey || !ready) return;
    setStored((prev) => {
      let changed = false;
      const next: Stored = { ...prev };
      for (const [label, hash] of Object.entries(currentHashes)) {
        if (next[label] === undefined) {
          next[label] = hash;
          changed = true;
        }
      }
      if (!changed) return prev;
      safeWrite(storageKey, next);
      return next;
    });
  }, [storageKey, currentHashes, ready]);

  const isUnseen = useCallback(
    (label: string) => {
      // While the categories are still resolving, never claim something
      // is unseen — we'd be comparing default-category hashes to the
      // personalized hashes the user already acked.
      if (!ready) return false;
      const current = currentHashes[label];
      const seen = stored[label];
      if (current === undefined || seen === undefined) return false;
      return current !== seen;
    },
    [currentHashes, stored, ready],
  );

  const markSeen = useCallback(
    (label: string) => {
      if (!storageKey) return;
      const current = currentHashes[label];
      if (current === undefined) return;
      setStored((prev) => {
        if (prev[label] === current) return prev;
        const next: Stored = { ...prev, [label]: current };
        safeWrite(storageKey, next);
        return next;
      });
    },
    [storageKey, currentHashes],
  );

  return { isUnseen, markSeen };
}
