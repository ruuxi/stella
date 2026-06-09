import { randomUUID } from "node:crypto";
import type {
  StoreInstallRecord,
  StoreReleaseSourcePack,
} from "../contracts/index.js";
import { listGitDirtyFiles } from "../kernel/self-mod/git/log.js";
import type { StellaSourceApplyResult } from "../kernel/self-mod/stella-source-control.js";
import type { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import {
  applyCleanSourceImportToWorkingTree,
  preflightSourcePackImport,
} from "./source-import-core.js";
import { runMechanicalApplyWithLifecycle } from "./mechanical-apply.js";

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

  const conversationId = `store-install:${args.source.packageId}`;
  const result = await runMechanicalApplyWithLifecycle({
    runId: `store-import-fast:${args.source.packageId}:${randomUUID()}`,
    conversationId,
    repoRoot: args.repoRoot,
    service: args.service,
    begin: {
      taskDescription: `${args.applyMode === "update" ? "Update" : "Install"} ${args.source.displayName} from Store`,
      packageId: args.source.packageId,
      releaseNumber: args.source.releaseNumber,
      applyMode: args.applyMode,
    },
    changedPaths: preflight.sourceApply.appliedPaths,
    lifecycle: args.lifecycle,
    // The source-pack writer runs its own dependency install.
    installDependencies: false,
    apply: async () => {
      await applyCleanSourceImportToWorkingTree({
        repoRoot: args.repoRoot,
        sourcePaths: preflight.sourcePaths,
        sourceApply: preflight.sourceApply,
      });
    },
    noCommitError:
      "Source import fast path wrote changes but did not create an install commit.",
  });

  return {
    status: "applied",
    installRecord: args.service.recordInstall({
      packageId: args.source.packageId,
      releaseNumber: args.source.releaseNumber,
      installCommitHash: result.commitHash,
      sourceRevisionId: result.sourceRevisionId ?? null,
      sourceRevisionIds: [args.source.sourcePack.revisionId],
    }),
  };
};
