import {
  createStellaSourceChangeSet,
  hashSourceBlob,
  sourceBlobFromBuffer,
  type StellaSourceBlob,
  type StellaSourceChange,
  type StellaSourceChangeSet,
} from "./stella-source-control.js";
import {
  getCommitFileSnapshot,
  getGitCommitParent,
  listFilesForCommit,
} from "./git.js";

const snapshotToBlob = (
  snapshot: Awaited<ReturnType<typeof getCommitFileSnapshot>>,
): StellaSourceBlob | undefined => {
  if (snapshot.deleted || !snapshot.contentBase64) return undefined;
  return sourceBlobFromBuffer(Buffer.from(snapshot.contentBase64, "base64"));
};

export const buildStellaSourceChangeSetForGitCommit = async (args: {
  repoRoot: string;
  commitHash: string;
  parentRevisionId?: string | null;
  featureId?: string;
  description?: string;
}): Promise<{
  parentCommitHash: string | null;
  changeSet: StellaSourceChangeSet;
}> => {
  const commitHash = args.commitHash.trim();
  if (!commitHash) {
    throw new Error("commitHash is required.");
  }
  const parentCommitHash = await getGitCommitParent(args.repoRoot, commitHash);
  const baseRevisionId =
    args.parentRevisionId?.trim() ||
    (parentCommitHash ? `git:${parentCommitHash}` : "stella-root");
  const files = await listFilesForCommit(args.repoRoot, commitHash);
  const changes: StellaSourceChange[] = [];

  for (const filePath of files) {
    const baseSnapshot = parentCommitHash
      ? await getCommitFileSnapshot({
          repoRoot: args.repoRoot,
          commitHash: parentCommitHash,
          filePath,
        })
      : { path: filePath, deleted: true as const };
    const nextSnapshot = await getCommitFileSnapshot({
      repoRoot: args.repoRoot,
      commitHash,
      filePath,
    });
    const base = snapshotToBlob(baseSnapshot);
    const next = snapshotToBlob(nextSnapshot);
    const baseHash = hashSourceBlob(base);
    const nextHash = hashSourceBlob(next);
    if (baseHash === nextHash) continue;
    changes.push({
      path: filePath,
      baseHash,
      nextHash,
    });
  }

  return {
    parentCommitHash,
    changeSet: createStellaSourceChangeSet({
      baseRevisionId,
      parentRevisionIds: [baseRevisionId],
      ...(args.featureId ? { featureId: args.featureId } : {}),
      ...(args.description ? { description: args.description } : {}),
      changes,
    }),
  };
};
