import type { SelfModAppliedPayload } from "../../contracts/local-chat.js";
import { isStellaSelfModCommitMessage } from "./git/trailers.js";

/**
 * Event-driven replacement for git-based self-mod detection on the run
 * finalize path.
 *
 * Every self-mod commit lands through `commitGitMessage` in THIS worker, so
 * the committer pushes the fact into this in-memory ledger and run
 * finalization reads it back — no `git` subprocess on any hot path. The
 * orchestrator's per-turn flow becomes: capture the ledger cursor at run
 * start, and at agent_end surface the newest entry recorded past that
 * cursor.
 *
 * Deliberate trade-off vs the old `git log --grep` scan: commits created
 * OUTSIDE this worker process (another instance, a human in a terminal)
 * are not seen. Self-mod applies are worker-owned by design, and the old
 * scan's cost was paid on EVERY successful orchestrator turn — including
 * one observed wedged git exec that silently withheld RUN_FINISHED and
 * froze the conversation.
 */

type SelfModLedgerEntry = {
  seq: number;
  commitHash: string;
  files: string[];
  atMs: number;
};

const MAX_LEDGER_ENTRIES = 200;

let nextSeq = 1;
const entries: SelfModLedgerEntry[] = [];

/**
 * Record a commit the worker just created. No-ops unless the full commit
 * message matches the Stella self-mod trailer contract — the same filter
 * the git-based detector applied — so unrelated commits routed through the
 * shared committer can never surface an "Apply Stella update" card.
 */
export const recordSelfModCommitInLedger = (args: {
  commitHash: string;
  files: readonly string[];
  /** Full commit message (subject + body + trailers) for the filter. */
  message: string;
}): void => {
  const commitHash = args.commitHash.trim();
  if (!commitHash) return;
  if (!isStellaSelfModCommitMessage(args.message)) return;
  entries.push({
    seq: nextSeq++,
    commitHash,
    files: [...args.files],
    atMs: Date.now(),
  });
  if (entries.length > MAX_LEDGER_ENTRIES) {
    entries.splice(0, entries.length - MAX_LEDGER_ENTRIES);
  }
};

/**
 * Opaque cursor for "now" — captured at run start (before_agent_start) and
 * echoed back to {@link detectSelfModAppliedSinceCursor} at agent_end.
 */
export const currentSelfModLedgerCursor = (): string => String(nextSeq - 1);

/**
 * Newest self-mod commit recorded after `cursor`, or null. A missing or
 * malformed cursor detects nothing — with the infallible cursor capture
 * that can only mean a caller that never captured one, and guessing risks
 * resurfacing an old commit on an unrelated turn.
 */
export const detectSelfModAppliedSinceCursor = (
  cursor: string | null | undefined,
): SelfModAppliedPayload | null => {
  if (cursor == null || !cursor.trim()) return null;
  const since = Number(cursor);
  if (!Number.isFinite(since)) return null;
  let latest: SelfModLedgerEntry | undefined;
  for (const entry of entries) {
    if (entry.seq > since) latest = entry;
  }
  if (!latest) return null;
  return {
    commitHash: latest.commitHash,
    files: [...latest.files],
    batchIndex: 0,
  };
};

/** Test hook: clear all ledger state. */
export const resetSelfModLedgerForTests = (): void => {
  entries.splice(0, entries.length);
  nextSeq = 1;
};
