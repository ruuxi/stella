import type { StoreReleaseSourcePack } from "../contracts/index.js";
import {
  applyStellaSourcePack,
  type StellaSourceApplyResult,
} from "../kernel/self-mod/stella-source-control.js";
import {
  collectSourcePackPaths,
  findStoreSourcePackApplyObstruction,
  readLocalSourceTree,
  runStorePublishDependencyInstall,
  storePublishTouchesDependencyFiles,
  writeSourcePackApplyResult,
  type StoreSourcePackApplyObstruction,
} from "./store-source-pack-install.js";

export type SourceImportDirtyTreeResult =
  | { dirty: false }
  | {
      dirty: true;
      reason: string;
      dirtyFileCount?: number;
    };

export type SourceImportPreflightResult =
  | {
      status: "clean";
      sourcePack: StoreReleaseSourcePack;
      sourcePaths: string[];
      sourceApply: StellaSourceApplyResult & { status: "clean" };
    }
  | {
      status: "conflicts";
      sourcePack: StoreReleaseSourcePack;
      sourcePaths: string[];
      sourceApply: StellaSourceApplyResult & { status: "conflicts" };
      reason: string;
    }
  | {
      status: "needs-agent";
      sourcePack: StoreReleaseSourcePack;
      sourcePaths: string[];
      reason: string;
      dirtyFileCount?: number;
      obstruction?: StoreSourcePackApplyObstruction;
    };

export const preflightSourcePackImport = async (args: {
  repoRoot: string;
  sourcePack: StoreReleaseSourcePack;
  inspectDirtyTree?: () => Promise<SourceImportDirtyTreeResult>;
  isPathTracked?: (path: string) => Promise<boolean>;
}): Promise<SourceImportPreflightResult> => {
  const sourcePaths = collectSourcePackPaths(args.sourcePack);

  if (sourcePaths.length > 0 && args.inspectDirtyTree) {
    const dirtyTree = await args.inspectDirtyTree();
    if (dirtyTree.dirty) {
      return {
        status: "needs-agent",
        sourcePack: args.sourcePack,
        sourcePaths,
        reason: dirtyTree.reason,
        ...(typeof dirtyTree.dirtyFileCount === "number"
          ? { dirtyFileCount: dirtyTree.dirtyFileCount }
          : {}),
      };
    }
  }

  const obstruction =
    sourcePaths.length > 0
      ? await findStoreSourcePackApplyObstruction({
          repoRoot: args.repoRoot,
          paths: sourcePaths,
          ...(args.isPathTracked ? { isPathTracked: args.isPathTracked } : {}),
        })
      : null;
  if (obstruction) {
    return {
      status: "needs-agent",
      sourcePack: args.sourcePack,
      sourcePaths,
      reason: obstruction.reason,
      obstruction,
    };
  }

  const localTree =
    sourcePaths.length > 0
      ? await readLocalSourceTree(args.repoRoot, sourcePaths)
      : {};
  const sourceApply = applyStellaSourcePack({
    pack: args.sourcePack,
    localTree,
  });
  if (sourceApply.status !== "clean") {
    return {
      status: "conflicts",
      sourcePack: args.sourcePack,
      sourcePaths,
      sourceApply: sourceApply as StellaSourceApplyResult & {
        status: "conflicts";
      },
      reason: "The source import reported conflicts.",
    };
  }

  return {
    status: "clean",
    sourcePack: args.sourcePack,
    sourcePaths,
    sourceApply: sourceApply as StellaSourceApplyResult & { status: "clean" },
  };
};

export const applyCleanSourceImportToWorkingTree = async (args: {
  repoRoot: string;
  sourcePaths: string[];
  sourceApply: StellaSourceApplyResult & { status: "clean" };
  installDependencies?: boolean;
}): Promise<{ dependencyInstallRan: boolean }> => {
  if (args.sourceApply.appliedPaths.length === 0) {
    return { dependencyInstallRan: false };
  }

  await writeSourcePackApplyResult({
    repoRoot: args.repoRoot,
    paths: args.sourcePaths,
    tree: args.sourceApply.tree,
    appliedPaths: args.sourceApply.appliedPaths,
  });

  const dependencyInstallRan =
    args.installDependencies !== false &&
    storePublishTouchesDependencyFiles(args.sourceApply.appliedPaths);
  if (dependencyInstallRan) {
    await runStorePublishDependencyInstall(args.repoRoot);
  }

  return { dependencyInstallRan };
};
