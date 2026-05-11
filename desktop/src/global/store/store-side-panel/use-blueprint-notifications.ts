import { useEffect } from "react";
import { deriveBlueprintName, fireBlueprintNotification } from "./format";
import type { StoreThreadMessage } from "./types";

/**
 * Surface an OS notification when a brand-new blueprint draft arrives
 * (one we've never observed in this session OR a previous one). Seeds
 * the "seen" set on first load so existing drafts don't re-fire.
 *
 * State is persisted across panel mount/unmount in module scope (and
 * mirrored to localStorage) so switching to another display tab and
 * back doesn't replay the macOS notification chime — once you've seen
 * a draft, it stays seen.
 *
 * The seeding flag is gated on actually having received the thread
 * snapshot (we observe at least one message). Without that gate, the
 * seed runs synchronously on mount when `messages` is still `[]`
 * (before the async getThread resolves), the seen-set ends up empty,
 * and every existing draft is treated as new on the next render.
 */
const STORAGE_KEY = "stella-store-seen-blueprint-ids";
const STORAGE_LIMIT = 200;

const loadInitialSeen = (): Set<string> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
    }
  } catch {
    // ignore — best-effort persistence
  }
  return new Set();
};

const seenBlueprintIds: Set<string> = loadInitialSeen();
let hasSeededFromSnapshot = false;

const persistSeen = () => {
  if (typeof window === "undefined") return;
  try {
    // Cap the persisted list so it doesn't grow unbounded across sessions.
    const ids = Array.from(seenBlueprintIds).slice(-STORAGE_LIMIT);
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
};

export function useBlueprintNotifications(
  messages: StoreThreadMessage[],
): void {
  useEffect(() => {
    // Wait until the store thread snapshot has actually loaded before
    // deciding what's "new" — otherwise the synchronous initial-mount
    // pass with an empty messages array seeds nothing, and the next
    // render fires notifications for every pre-existing draft.
    if (messages.length === 0) return;

    const blueprints = messages.filter(
      (msg) => msg.role === "assistant" && msg.isBlueprint && !msg.denied,
    );

    if (!hasSeededFromSnapshot) {
      hasSeededFromSnapshot = true;
      let mutated = false;
      for (const msg of blueprints) {
        if (!seenBlueprintIds.has(msg._id)) {
          seenBlueprintIds.add(msg._id);
          mutated = true;
        }
      }
      if (mutated) persistSeen();
      return;
    }

    let mutated = false;
    for (const msg of blueprints) {
      if (seenBlueprintIds.has(msg._id)) continue;
      seenBlueprintIds.add(msg._id);
      mutated = true;
      fireBlueprintNotification(msg._id, deriveBlueprintName(msg.text));
    }
    if (mutated) persistSeen();
  }, [messages]);
}
