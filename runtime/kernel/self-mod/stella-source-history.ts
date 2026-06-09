import {
  createStellaSourceChangeSet,
  hashSourceBlob,
  sourceBlobFromBuffer,
  type StellaSourceChange,
  type StellaSourceChangeSet,
} from "./stella-source-control.js";
import { getGitCommitParent, listFilesForCommit } from "./git/log.js";
import { readGitObjectsBatch } from "./git/snapshots.js";

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

  // One `cat-file --batch` spawn covers every base+next blob instead of
  // two `git show` subprocesses per touched file.
  const specs = files.flatMap((filePath) => [
    ...(parentCommitHash ? [`${parentCommitHash}:${filePath}`] : []),
    `${commitHash}:${filePath}`,
  ]);
  const objects = await readGitObjectsBatch({
    repoRoot: args.repoRoot,
    specs,
  });

  const changes: StellaSourceChange[] = [];
  for (const filePath of files) {
    const baseBuffer = parentCommitHash
      ? (objects.get(`${parentCommitHash}:${filePath}`) ?? null)
      : null;
    const nextBuffer = objects.get(`${commitHash}:${filePath}`) ?? null;
    const base = baseBuffer ? sourceBlobFromBuffer(baseBuffer) : undefined;
    const next = nextBuffer ? sourceBlobFromBuffer(nextBuffer) : undefined;
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
