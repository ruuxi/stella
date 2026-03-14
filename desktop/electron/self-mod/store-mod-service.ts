import { promises as fs } from "fs";
import path from "path";
import type {
  InstalledStoreModRecord,
  SelfModBatchRecord,
  SelfModFeatureRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseDraft,
  StoreReleaseManifest,
} from "../../src/shared/contracts/electron-data.js";
import { StoreModStore } from "../storage/store-mod-store.js";
import {
  commitGitFeatureBatch,
  getCommitSelectionSnapshots,
  listGitDirtyFiles,
  stageFeatureDependencyFiles,
  stageGitFiles,
} from "./git.js";

type ActiveSelfModRun = {
  featureId: string;
  name: string;
  description: string;
  baselineDirtyFiles: Set<string>;
  taskDescription: string;
};

type PublishReleaseArgs = {
  packageId: string;
  featureId: string;
  displayName: string;
  description: string;
  releaseNotes?: string;
  manifest: StoreReleaseManifest;
  artifact: StoreReleaseArtifact;
};

type PublishReleaseResult = StorePackageReleaseRecord;

type FetchReleaseResult = {
  package: StorePackageRecord;
  release: StorePackageReleaseRecord;
  artifact: StoreReleaseArtifact;
};

const FEATURE_MAX_SLUG_LENGTH = 48;

const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, FEATURE_MAX_SLUG_LENGTH) || "self-mod";
};

const humanize = (value: string): string =>
  value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
    .trim() || value;

const shortHash = (value: string): string => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36).slice(0, 6);
};

const deriveFeatureId = (taskDescription: string): string => {
  const normalized = taskDescription.trim().toLowerCase();
  const slug = slugify(taskDescription);
  return `${slug}-${shortHash(normalized || slug)}`;
};

const normalizeFileList = (files: string[]): string[] =>
  Array.from(new Set(files.map((file) => file.trim().replace(/\\/g, "/")).filter(Boolean))).sort();

const ensureParentDir = async (repoRoot: string, relativePath: string) => {
  await fs.mkdir(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
};

const sortBatchesByOrdinal = (batches: SelfModBatchRecord[]) =>
  [...batches].sort((a, b) => a.ordinal - b.ordinal || a.createdAt - b.createdAt);

const isPublishableBatch = (batch: SelfModBatchRecord): boolean =>
  batch.state === "committed" && typeof batch.commitHash === "string" && batch.commitHash.length > 0;

const selectDefaultBatchIds = (batches: SelfModBatchRecord[]): string[] => {
  const ordered = sortBatchesByOrdinal(batches);
  const lastPublishedOrdinal = ordered.reduce(
    (max, batch) => (batch.state === "published" ? Math.max(max, batch.ordinal) : max),
    0,
  );
  const selection: string[] = [];
  for (const batch of ordered) {
    if (batch.ordinal <= lastPublishedOrdinal) {
      continue;
    }
    if (!isPublishableBatch(batch)) {
      break;
    }
    selection.push(batch.batchId);
  }
  return selection;
};

export class StoreModService {
  private readonly activeRuns = new Map<string, ActiveSelfModRun>();

  constructor(
    private readonly repoRoot: string,
    private readonly store: StoreModStore,
  ) {}

  async beginSelfModRun(args: {
    runId: string;
    taskDescription: string;
  }): Promise<SelfModFeatureRecord> {
    const taskDescription = args.taskDescription.trim() || "Self mod update";
    const featureId = deriveFeatureId(taskDescription);
    const name = humanize(featureId.replace(/-[a-z0-9]{1,6}$/, ""));
    const description = taskDescription;
    const baselineDirtyFiles = new Set(await listGitDirtyFiles(this.repoRoot));
    const feature = this.store.upsertFeature({
      featureId,
      name,
      description,
    });
    this.activeRuns.set(args.runId, {
      featureId,
      name,
      description,
      baselineDirtyFiles,
      taskDescription,
    });
    return feature;
  }

  cancelSelfModRun(runId: string): void {
    this.activeRuns.delete(runId);
  }

  async finalizeSelfModRun(args: {
    runId: string;
    succeeded: boolean;
  }): Promise<SelfModBatchRecord | null> {
    const activeRun = this.activeRuns.get(args.runId);
    this.activeRuns.delete(args.runId);
    if (!activeRun || !args.succeeded) {
      return null;
    }

    const currentDirtyFiles = normalizeFileList(await listGitDirtyFiles(this.repoRoot));
    if (currentDirtyFiles.length === 0) {
      return null;
    }

    const baselineDirty = activeRun.baselineDirtyFiles;
    const blockedFiles = currentDirtyFiles.filter((file) => baselineDirty.has(file));
    const safeFiles = currentDirtyFiles.filter((file) => !baselineDirty.has(file));
    const ordinal = this.store.getNextFeatureOrdinal(activeRun.featureId);

    if (safeFiles.length === 0) {
      return this.store.createBatch({
        featureId: activeRun.featureId,
        runId: args.runId,
        ordinal,
        state: "blocked",
        files: currentDirtyFiles,
        blockedFiles,
      });
    }

    await stageGitFiles(this.repoRoot, safeFiles);
    await stageFeatureDependencyFiles(this.repoRoot);
    const batchId = `batch:${activeRun.featureId}:${ordinal}`;
    const commitHash = await commitGitFeatureBatch({
      repoRoot: this.repoRoot,
      featureId: activeRun.featureId,
      batchId,
      ordinal,
      taskDescription: activeRun.taskDescription,
    });
    if (!commitHash) {
      return null;
    }

    return this.store.createBatch({
      batchId,
      featureId: activeRun.featureId,
      runId: args.runId,
      ordinal,
      state: "committed",
      commitHash,
      files: safeFiles,
      blockedFiles,
    });
  }

  listLocalFeatures(limit?: number): SelfModFeatureRecord[] {
    const features = this.store.listFeatures();
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return features;
    }
    return features.slice(0, Math.max(0, Math.floor(limit)));
  }

  listFeatureBatches(featureId: string): SelfModBatchRecord[] {
    return sortBatchesByOrdinal(this.store.listBatches(featureId));
  }

  getInstalledModByPackageId(packageId: string): InstalledStoreModRecord | null {
    return this.store.getInstalledModByPackageId(packageId);
  }

  listInstalledMods(): InstalledStoreModRecord[] {
    return this.store.listInstalledMods();
  }

  createReleaseDraft(args: {
    featureId: string;
    batchIds?: string[];
  }): StoreReleaseDraft {
    const feature = this.store.getFeature(args.featureId);
    if (!feature) {
      throw new Error(`Unknown feature "${args.featureId}".`);
    }

    const allBatches = this.listFeatureBatches(args.featureId);
    const publishable = allBatches.filter(isPublishableBatch);
    if (publishable.length === 0) {
      throw new Error(`Feature "${args.featureId}" has no unpublished committed batches.`);
    }

    const selectedBatchIds = args.batchIds && args.batchIds.length > 0
      ? this.validateExplicitBatchSelection(publishable, args.batchIds)
      : selectDefaultBatchIds(allBatches);
    const batches = publishable.filter((batch) => selectedBatchIds.includes(batch.batchId));
    if (batches.length === 0) {
      throw new Error(`Feature "${args.featureId}" has no publishable batch selection.`);
    }

    return {
      feature,
      batches,
      selectedBatchIds,
      packageId: feature.packageId,
      displayName: feature.name,
      description: feature.description,
    };
  }

  async publishRelease(args: {
    featureId: string;
    batchIds?: string[];
    packageId?: string;
    displayName?: string;
    description?: string;
    releaseNotes?: string;
    publish: (args: PublishReleaseArgs) => Promise<PublishReleaseResult>;
  }): Promise<PublishReleaseResult> {
    const draft = this.createReleaseDraft({
      featureId: args.featureId,
      batchIds: args.batchIds,
    });
    const packageId = (args.packageId ?? draft.packageId ?? "").trim();
    if (!packageId) {
      throw new Error("packageId is required for the first publish.");
    }
    const displayName = (args.displayName ?? draft.displayName).trim();
    const description = (args.description ?? draft.description).trim();
    if (!displayName || !description) {
      throw new Error("displayName and description are required.");
    }

    const artifact = await this.buildReleaseArtifact({
      featureId: draft.feature.featureId,
      packageId,
      displayName,
      description,
      releaseNotes: args.releaseNotes?.trim(),
      batches: draft.batches,
    });

    const release = await args.publish({
      packageId,
      featureId: draft.feature.featureId,
      displayName,
      description,
      releaseNotes: args.releaseNotes?.trim(),
      manifest: artifact.manifest,
      artifact,
    });
    this.store.markBatchesPublished({
      featureId: draft.feature.featureId,
      batchIds: draft.selectedBatchIds,
      packageId,
      releaseNumber: release.releaseNumber,
    });
    return release;
  }

  async installRelease(args: {
    packageId: string;
    releaseNumber: number;
    fetchRelease: (args: {
      packageId: string;
      releaseNumber: number;
    }) => Promise<FetchReleaseResult>;
    commitApply: (args: {
      packageId: string;
      featureId: string;
      releaseNumber: number;
      touchedFiles: string[];
    }) => Promise<string>;
  }): Promise<InstalledStoreModRecord> {
    const payload = await args.fetchRelease({
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
    });
    await this.applyArtifact(payload.artifact);
    const touchedFiles = normalizeFileList(payload.artifact.files.map((file) => file.path));
    const commitHash = await args.commitApply({
      packageId: payload.package.packageId,
      featureId: payload.package.featureId,
      releaseNumber: payload.release.releaseNumber,
      touchedFiles,
    });
    return this.store.recordInstallCommit({
      packageId: payload.package.packageId,
      featureId: payload.package.featureId,
      releaseNumber: payload.release.releaseNumber,
      applyCommitHash: commitHash,
    });
  }

  markInstallUninstalled(installId: string): void {
    this.store.markInstallUninstalled(installId);
  }

  private validateExplicitBatchSelection(
    pending: SelfModBatchRecord[],
    requestedBatchIds: string[],
  ): string[] {
    const uniqueRequested = Array.from(new Set(requestedBatchIds));
    const byId = new Map(pending.map((batch) => [batch.batchId, batch]));
    const selected = uniqueRequested.map((batchId) => {
      const batch = byId.get(batchId);
      if (!batch) {
        throw new Error(`Batch "${batchId}" is not publishable.`);
      }
      return batch;
    });
    return sortBatchesByOrdinal(selected).map((batch) => batch.batchId);
  }

  private async buildReleaseArtifact(args: {
    featureId: string;
    packageId: string;
    displayName: string;
    description: string;
    releaseNotes?: string;
    batches: SelfModBatchRecord[];
  }): Promise<StoreReleaseArtifact> {
    const orderedBatches = sortBatchesByOrdinal(args.batches).filter((batch) => batch.commitHash);
    if (orderedBatches.length === 0) {
      throw new Error("Selected batches do not have committed changes.");
    }

    const files = normalizeFileList(
      orderedBatches.flatMap((batch) => batch.files),
    );
    const snapshots = await getCommitSelectionSnapshots({
      repoRoot: this.repoRoot,
      commitHashes: orderedBatches.map((batch) => batch.commitHash!).filter(Boolean),
      files,
    });

    const manifest: StoreReleaseManifest = {
      featureId: args.featureId,
      packageId: args.packageId,
      releaseNumber: 0,
      displayName: args.displayName,
      description: args.description,
      ...(args.releaseNotes ? { releaseNotes: args.releaseNotes } : {}),
      batchIds: orderedBatches.map((batch) => batch.batchId),
      commitHashes: orderedBatches.map((batch) => batch.commitHash!).filter(Boolean),
      files,
      createdAt: Date.now(),
    };

    return {
      manifest,
      files: snapshots,
    };
  }

  private async applyArtifact(artifact: StoreReleaseArtifact): Promise<void> {
    for (const file of artifact.files) {
      const relativePath = file.path.replace(/\\/g, "/");
      const absolutePath = path.join(this.repoRoot, relativePath);
      if (file.deleted) {
        await fs.rm(absolutePath, { force: true });
        continue;
      }
      if (!file.contentBase64) {
        continue;
      }
      await ensureParentDir(this.repoRoot, relativePath);
      await fs.writeFile(absolutePath, Buffer.from(file.contentBase64, "base64"));
    }
  }
}
