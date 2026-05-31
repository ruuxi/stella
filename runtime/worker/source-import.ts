import { randomUUID } from "node:crypto";
import type {
  StoreInstallRecord,
  StoreReleaseSourcePack,
} from "../contracts/index.js";
import { listGitDirtyFiles } from "../kernel/self-mod/git.js";
import type { StellaSourceApplyResult } from "../kernel/self-mod/stella-source-control.js";
import type { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import {
  applyCleanSourceImportToWorkingTree,
  preflightSourcePackImport,
} from "./source-import-core.js";
import {
  STORE_SOURCE_DEPENDENCY_FILE_NAMES,
  storeSourcePackTouchesDependencyFiles,
} from "./store-source-pack-install.js";

export type SourceImportTrust = "trusted" | "untrusted";

export type SourceImportApplyMode = "install" | "update";

export type SourceImportScope = {
  kind: "all" | "feature";
  label?: string;
};

export type SourceImportSource =
  | {
      kind: "store-package";
      packageId: string;
      releaseNumber: number;
      displayName: string;
      sourcePack: StoreReleaseSourcePack;
    }
  | {
      kind: "upstream-release";
      displayName: string;
      sourcePack: StoreReleaseSourcePack;
    };

export type SourceImportLifecycle = {
  beginExternalSelfMod?: (args: {
    runId: string;
    paths: string[];
  }) => Promise<{ ok: true }>;
  finishExternalSelfMod?: (args: {
    runId: string;
    succeeded: boolean;
  }) => Promise<{ ok: true }>;
};

export type SourceImportFastPathResult =
  | {
      status: "applied";
      installRecord: StoreInstallRecord;
    }
  | {
      status: "needs-agent";
      reason: string;
      conflicts?: StellaSourceApplyResult["conflicts"];
    };

export type SourceImportFastPathArgs = {
  repoRoot: string;
  service: StoreModService;
  source: Extract<SourceImportSource, { kind: "store-package" }>;
  scope: SourceImportScope;
  trust: SourceImportTrust;
  applyMode: SourceImportApplyMode;
  lifecycle?: SourceImportLifecycle;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

const expandExternalSelfModPaths = (paths: string[]): string[] => {
  const expanded = new Set(paths);
  if (storeSourcePackTouchesDependencyFiles(paths)) {
    for (const dependencyFile of STORE_SOURCE_DEPENDENCY_FILE_NAMES) {
      expanded.add(dependencyFile);
    }
  }
  return [...expanded];
};

export const trySourceImportFastPath = async (
  args: SourceImportFastPathArgs,
): Promise<SourceImportFastPathResult> => {
  const preflight = await preflightSourcePackImport({
    repoRoot: args.repoRoot,
    sourcePack: args.source.sourcePack,
    inspectDirtyTree: async () => {
      const dirtyFiles = await listGitDirtyFiles(args.repoRoot);
      return dirtyFiles.length > 0
        ? {
            dirty: true,
            reason: "The install tree has local working-tree changes.",
            dirtyFileCount: dirtyFiles.length,
          }
        : { dirty: false };
    },
  });

  if (
    preflight.status === "needs-agent" &&
    typeof preflight.dirtyFileCount === "number"
  ) {
    args.log?.("source-import.fast.skip.dirty-tree", {
      packageId: args.source.packageId,
      releaseNumber: args.source.releaseNumber,
      dirtyFileCount: preflight.dirtyFileCount,
    });
    return {
      status: "needs-agent",
      reason: preflight.reason,
    };
  }

  if (preflight.status === "needs-agent") {
    args.log?.("source-import.fast.skip.obstructed", {
      packageId: args.source.packageId,
      releaseNumber: args.source.releaseNumber,
      path: preflight.obstruction?.path,
      reason: preflight.reason,
    });
    return {
      status: "needs-agent",
      reason: preflight.reason,
    };
  }

  if (preflight.status === "conflicts") {
    args.log?.("source-import.fast.skip.conflicts", {
      packageId: args.source.packageId,
      releaseNumber: args.source.releaseNumber,
      conflictCount: preflight.sourceApply.conflicts.length,
    });
    return {
      status: "needs-agent",
      reason: preflight.reason,
      conflicts: preflight.sourceApply.conflicts,
    };
  }

  if (preflight.sourceApply.appliedPaths.length === 0) {
    return {
      status: "applied",
      installRecord: args.service.recordInstall({
        packageId: args.source.packageId,
        releaseNumber: args.source.releaseNumber,
        installCommitHash: null,
        sourceRevisionId: args.source.sourcePack.revisionId,
      }),
    };
  }

  const runId = `store-import-fast:${args.source.packageId}:${randomUUID()}`;
  const conversationId = `store-install:${args.source.packageId}`;
  let hmrRunStarted = false;
  await args.service.beginSelfModRun({
    runId,
    taskDescription: `${args.applyMode === "update" ? "Update" : "Install"} ${args.source.displayName} from Store`,
    packageId: args.source.packageId,
    releaseNumber: args.source.releaseNumber,
    applyMode: args.applyMode,
  });
  try {
    if (args.lifecycle?.beginExternalSelfMod) {
      await args.lifecycle.beginExternalSelfMod({
        runId,
        paths: expandExternalSelfModPaths(preflight.sourceApply.appliedPaths),
      });
      hmrRunStarted = true;
    }

    await applyCleanSourceImportToWorkingTree({
      repoRoot: args.repoRoot,
      sourcePaths: preflight.sourcePaths,
      sourceApply: preflight.sourceApply,
    });

    const finalized = await args.service.finalizeSelfModRun({
      runId,
      succeeded: true,
      conversationId,
      threadKey: conversationId,
    });
    if (!finalized?.commitHash) {
      throw new Error(
        "Source import fast path wrote changes but did not create an install commit.",
      );
    }

    if (hmrRunStarted && args.lifecycle?.finishExternalSelfMod) {
      await args.lifecycle.finishExternalSelfMod({
        runId,
        succeeded: true,
      });
      hmrRunStarted = false;
    }

    return {
      status: "applied",
      installRecord: args.service.recordInstall({
        packageId: args.source.packageId,
        releaseNumber: args.source.releaseNumber,
        installCommitHash: finalized.commitHash,
        sourceRevisionId: finalized.sourceRevisionId ?? null,
        sourceRevisionIds: [args.source.sourcePack.revisionId],
      }),
    };
  } catch (error) {
    args.service.cancelSelfModRun(runId);
    if (hmrRunStarted && args.lifecycle?.finishExternalSelfMod) {
      await args.lifecycle
        .finishExternalSelfMod({ runId, succeeded: false })
        .catch(() => undefined);
    }
    throw error;
  }
};
