/**
 * Pure helpers for turning staged self-mod changes into chat cards.
 *
 * A change is staged from the run's tracked writes when the run finalizes, so
 * a card can exist before — or entirely without — a commit. Applying is an HMR
 * swap of content already on disk; the commit is bookkeeping that only Undo
 * needs. These helpers hold the "which card, built how" rules so both attach
 * paths (turn end, and a run that finalized after its turn ended) share them
 * and can be tested without standing up the worker server.
 */
import type { SelfModAppliedPayload } from "../contracts/local-chat.js";
import type { PendingSelfModApply } from "./self-mod-coordinator.js";

/**
 * Staged changes for `conversationId` that have not been attached to a reply
 * yet. Iteration order is the map's, i.e. finalize order.
 */
export const selectUnattachedPendingCards = (
  pending: Iterable<PendingSelfModApply>,
  conversationId: string,
): PendingSelfModApply[] => {
  const trimmed = conversationId?.trim();
  if (!trimmed) return [];
  return [...pending].filter(
    (entry) =>
      entry.conversationId === trimmed && !entry.assistantMessageEventId,
  );
};

/**
 * The persisted card for a staged change. `commitHash` is omitted until the
 * run's commit lands, which is what keeps Undo hidden until then.
 */
export const buildSelfModCardPayload = (
  pending: PendingSelfModApply,
): SelfModAppliedPayload & { applyId: string } => ({
  applyId: pending.applyId,
  ...(pending.commitHash ? { commitHash: pending.commitHash } : {}),
  files: pending.files,
  batchIndex: 0,
  status: "pending",
});
