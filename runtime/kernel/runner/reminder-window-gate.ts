/**
 * Generic "once per active context window" gate for injected reminders.
 *
 * Injected system reminders (connector availability, and any future
 * reminder types) should not repeat while a copy already sits in the
 * orchestrator's model-facing window. Hook-injected reminders are
 * ephemeral prompt messages — they are NOT persisted into the thread
 * store (`run-execution` only persists `user` and `bootstrap.*` prompt
 * messages) — so presence can't be detected by scanning the window
 * text. Instead the gate keeps tiny side-state per (threadKey, key):
 * the timestamp a reminder was last injected.
 *
 * "Active context window" is the runtime's own definition: everything
 * after the latest compaction checkpoint. `store.loadThreadMessages`
 * returns the window with compaction overlays applied — compacted
 * ranges collapse into a checkpoint-summary message carrying the
 * compaction timestamp. A reminder is "in the active window" iff it
 * was last shown AFTER that latest checkpoint:
 *
 *  - same window → suppressed;
 *  - a new compaction checkpoint resets the window → the reminder is
 *    eligible again (the checkpoint summary never counts as the
 *    reminder still being present — it's a summary, not the reminder).
 *
 * Reminder identity is a caller-chosen string key (e.g.
 * `connector-offer:gmail`). Callers layer their own stronger
 * suppressions on top (the connector hook's decline persistence wins
 * over window resets).
 */

import path from "node:path";

import {
  readJsonStateFile,
  updateJsonStateFile,
} from "../shared/atomic-json-state.js";
import { parseThreadCheckpoint } from "../thread-runtime.js";

export type ReminderWindowStore = {
  loadThreadMessages: (
    threadKey: string,
  ) => Array<{ content: string; timestamp: number }>;
};

const STATE_FILE_SEGMENTS = ["runtime", "reminder-window-state.json"] as const;

/** Cap on tracked (threadKey, key) pairs; oldest entries get pruned. */
const MAX_TRACKED_ENTRIES = 500;

type ReminderWindowStateFile = {
  version: 1;
  /** threadKey → reminder key → last-shown epoch millis. */
  shown: Record<string, Record<string, number>>;
};

const statePath = (stellaDataDir: string) =>
  path.join(stellaDataDir, ...STATE_FILE_SEGMENTS);

const parseState = (raw: unknown): ReminderWindowStateFile => {
  const parsed = raw as ReminderWindowStateFile | undefined;
  if (parsed?.version === 1 && parsed.shown) return parsed;
  // Missing/corrupt state file means nothing has been shown.
  return { version: 1, shown: {} };
};

const readState = async (
  stellaDataDir: string,
): Promise<ReminderWindowStateFile> =>
  readJsonStateFile(statePath(stellaDataDir), parseState);

const pruneState = (state: ReminderWindowStateFile) => {
  const flat: Array<{ threadKey: string; key: string; at: number }> = [];
  for (const [threadKey, keys] of Object.entries(state.shown)) {
    for (const [key, at] of Object.entries(keys)) {
      flat.push({ threadKey, key, at });
    }
  }
  if (flat.length <= MAX_TRACKED_ENTRIES) return;
  flat.sort((left, right) => right.at - left.at);
  const kept = flat.slice(0, MAX_TRACKED_ENTRIES);
  const shown: ReminderWindowStateFile["shown"] = {};
  for (const entry of kept) {
    (shown[entry.threadKey] ??= {})[entry.key] = entry.at;
  }
  state.shown = shown;
};



/**
 * Timestamp of the latest compaction checkpoint visible in the thread's
 * model-facing window, or 0 when the thread has never been compacted
 * (or can't be read — an unreadable thread has no checkpoints).
 */
export const getLastCompactionAt = (
  store: ReminderWindowStore,
  threadKey: string,
): number => {
  let messages: Array<{ content: string; timestamp: number }>;
  try {
    messages = store.loadThreadMessages(threadKey);
  } catch {
    return 0;
  }
  let latest = 0;
  for (const message of messages) {
    if (typeof message.content !== "string" || !message.content) continue;
    if (parseThreadCheckpoint(message.content) === null) continue;
    if (Number.isFinite(message.timestamp) && message.timestamp > latest) {
      latest = message.timestamp;
    }
  }
  return latest;
};

/**
 * True while the reminder identified by `key` still sits in the
 * thread's active context window (shown after the latest compaction
 * checkpoint).
 */
export const isReminderShownInActiveWindow = async (options: {
  stellaDataDir: string;
  store: ReminderWindowStore;
  threadKey: string;
  key: string;
}): Promise<boolean> => {
  const state = await readState(options.stellaDataDir);
  const shownAt = state.shown[options.threadKey]?.[options.key];
  if (typeof shownAt !== "number" || !Number.isFinite(shownAt)) return false;
  const lastCompactionAt = getLastCompactionAt(
    options.store,
    options.threadKey,
  );
  return shownAt > lastCompactionAt;
};

export const recordReminderShown = async (options: {
  stellaDataDir: string;
  threadKey: string;
  key: string;
  timestamp?: number;
}): Promise<void> => {
  await updateJsonStateFile({
    filePath: statePath(options.stellaDataDir),
    parse: parseState,
    update: (state) => {
      (state.shown[options.threadKey] ??= {})[options.key] =
        options.timestamp ?? Date.now();
      pruneState(state);
    },
  });
};
