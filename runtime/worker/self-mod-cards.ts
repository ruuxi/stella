/**
 * Pure helpers for turning staged self-mod changes into chat cards.
 *
 * A contribution is staged from a run's tracked writes when that run finalizes.
 * Publication happens later, when its owning General's automatic terminal
 * final is delivered upward. The resulting stable change set is attached only
 * at that completion's orchestrator-facing assistant boundary.
 */
import type { SelfModAppliedPayload } from "../contracts/local-chat.js";
import type { PendingSelfModApply } from "./self-mod-coordinator.js";

export type PendingSelfModChangeSet = {
  applyId: string;
  changeSetId: string;
  conversationId: string;
  assistantMessageEventId: string;
  ownerThreadId?: string;
  completionEventId?: string;
  contributions: PendingSelfModApply[];
};

/**
 * Claim one set that its owning General has already published. Finalized but
 * unpublished contributions are invisible here. Later completions keep
 * distinct change-set ids and therefore belong to later reply/card boundaries.
 */
export const claimPublishedSelfModChangeSet = (args: {
  pending: Iterable<PendingSelfModApply>;
  conversationId: string;
  assistantMessageEventId: string;
  completionEventId: string;
}): PendingSelfModChangeSet | null => {
  const conversationId = args.conversationId.trim();
  const assistantMessageEventId = args.assistantMessageEventId.trim();
  const completionEventId = args.completionEventId.trim();
  if (!conversationId || !assistantMessageEventId || !completionEventId) {
    return null;
  }
  const published = [...args.pending].filter(
    (entry) =>
      entry.conversationId === conversationId &&
      Boolean(entry.changeSetId) &&
      !entry.assistantMessageEventId &&
      entry.completionEventId === completionEventId,
  );
  const changeSetId = published[0]?.changeSetId;
  if (!changeSetId) return null;
  const contributions = published.filter(
    (entry) => entry.changeSetId === changeSetId,
  );
  if (contributions.length === 0) return null;
  for (const contribution of contributions) {
    contribution.changeSetId = changeSetId;
    contribution.assistantMessageEventId = assistantMessageEventId;
  }
  return {
    applyId: changeSetId,
    changeSetId,
    conversationId,
    assistantMessageEventId,
    ...(contributions[0]?.ownerThreadId
      ? { ownerThreadId: contributions[0].ownerThreadId }
      : {}),
    ...(contributions[0]?.completionEventId
      ? { completionEventId: contributions[0].completionEventId }
      : {}),
    contributions,
  };
};

/**
 * The persisted card for a staged change. Commit selectors are exposed only
 * when every contribution landed a commit, so the renderer can never offer a
 * partial Undo for a grouped update.
 */
export const buildSelfModCardPayload = (
  changeSet: PendingSelfModChangeSet,
): SelfModAppliedPayload & { applyId: string; status: "pending" } => ({
  applyId: changeSet.applyId,
  changeSetId: changeSet.changeSetId,
  ...(() => {
    const contributionCommitHashes = changeSet.contributions.map(
      (entry) => entry.commitHash?.trim() ?? "",
    );
    const hasCompleteCommitSet =
      contributionCommitHashes.every(Boolean) &&
      new Set(contributionCommitHashes).size ===
        changeSet.contributions.length;
    const commitHashes = hasCompleteCommitSet
      ? contributionCommitHashes
      : [];
    return {
      ...(changeSet.contributions.length === 1 && commitHashes.length === 1
        ? { commitHash: commitHashes[0] }
        : {}),
      ...(changeSet.contributions.length > 1 && commitHashes.length > 0
        ? { commitHashes }
        : {}),
    };
  })(),
  files: [...new Set(changeSet.contributions.flatMap((entry) => entry.files))],
  batchIndex: 0,
  status: "pending",
});
