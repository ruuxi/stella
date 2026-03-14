import type {
  InstalledStoreModRecord,
  SelfModBatchRecord,
  SelfModFeatureRecord,
} from "../../src/shared/contracts/electron-data.js";
import type { SqliteDatabase } from "./shared.js";
import { generateLocalId } from "./shared.js";

type FeatureRow = {
  featureId: string;
  name: string;
  description: string;
  packageId: string | null;
  createdAt: number;
  updatedAt: number;
};

type BatchRow = {
  batchId: string;
  featureId: string;
  runId: string | null;
  ordinal: number;
  state: SelfModBatchRecord["state"];
  commitHash: string | null;
  filesJson: string;
  blockedFilesJson: string | null;
  packageId: string | null;
  releaseNumber: number | null;
  createdAt: number;
  updatedAt: number;
};

type InstallRow = {
  installId: string;
  packageId: string;
  featureId: string;
  releaseNumber: number;
  applyCommitHashesJson: string;
  state: InstalledStoreModRecord["state"];
  createdAt: number;
  updatedAt: number;
};

const parseJsonStringArray = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
};

const toFeatureRecord = (row: FeatureRow): SelfModFeatureRecord => ({
  featureId: row.featureId,
  name: row.name,
  description: row.description,
  ...(row.packageId ? { packageId: row.packageId } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toBatchRecord = (row: BatchRow): SelfModBatchRecord => ({
  batchId: row.batchId,
  featureId: row.featureId,
  ...(row.runId ? { runId: row.runId } : {}),
  ordinal: row.ordinal,
  state: row.state,
  ...(row.commitHash ? { commitHash: row.commitHash } : {}),
  files: parseJsonStringArray(row.filesJson),
  ...(row.blockedFilesJson ? { blockedFiles: parseJsonStringArray(row.blockedFilesJson) } : {}),
  ...(row.packageId ? { packageId: row.packageId } : {}),
  ...(row.releaseNumber == null ? {} : { releaseNumber: row.releaseNumber }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toInstallRecord = (row: InstallRow): InstalledStoreModRecord => ({
  installId: row.installId,
  packageId: row.packageId,
  featureId: row.featureId,
  releaseNumber: row.releaseNumber,
  applyCommitHashes: parseJsonStringArray(row.applyCommitHashesJson),
  state: row.state,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class StoreModStore {
  constructor(private readonly db: SqliteDatabase) {}

  upsertFeature(args: {
    featureId: string;
    name: string;
    description: string;
    packageId?: string;
  }): SelfModFeatureRecord {
    const now = Date.now();
    const existing = this.db.prepare(`
      SELECT
        feature_id AS featureId,
        name,
        description,
        package_id AS packageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM self_mod_features
      WHERE feature_id = ?
      LIMIT 1
    `).get(args.featureId) as FeatureRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE self_mod_features
        SET
          name = ?,
          description = ?,
          package_id = COALESCE(?, package_id),
          updated_at = ?
        WHERE feature_id = ?
      `).run(
        args.name,
        args.description,
        args.packageId ?? null,
        now,
        args.featureId,
      );
      return {
        ...toFeatureRecord(existing),
        name: args.name,
        description: args.description,
        packageId: args.packageId ?? existing.packageId ?? undefined,
        updatedAt: now,
      };
    }

    this.db.prepare(`
      INSERT INTO self_mod_features (
        feature_id,
        name,
        description,
        package_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      args.featureId,
      args.name,
      args.description,
      args.packageId ?? null,
      now,
      now,
    );

    return {
      featureId: args.featureId,
      name: args.name,
      description: args.description,
      ...(args.packageId ? { packageId: args.packageId } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  getFeature(featureId: string): SelfModFeatureRecord | null {
    const row = this.db.prepare(`
      SELECT
        feature_id AS featureId,
        name,
        description,
        package_id AS packageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM self_mod_features
      WHERE feature_id = ?
      LIMIT 1
    `).get(featureId) as FeatureRow | undefined;
    return row ? toFeatureRecord(row) : null;
  }

  listFeatures(): SelfModFeatureRecord[] {
    const rows = this.db.prepare(`
      SELECT
        feature_id AS featureId,
        name,
        description,
        package_id AS packageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM self_mod_features
      ORDER BY updated_at DESC, feature_id ASC
    `).all() as FeatureRow[];
    return rows.map(toFeatureRecord);
  }

  bindFeaturePackage(featureId: string, packageId: string): void {
    this.db.prepare(`
      UPDATE self_mod_features
      SET package_id = ?, updated_at = ?
      WHERE feature_id = ?
    `).run(packageId, Date.now(), featureId);
  }

  getNextFeatureOrdinal(featureId: string): number {
    const row = this.db.prepare(`
      SELECT MAX(ordinal) AS maxOrdinal
      FROM self_mod_batches
      WHERE feature_id = ?
    `).get(featureId) as { maxOrdinal?: number | null } | undefined;
    return Math.max(0, Number(row?.maxOrdinal ?? 0)) + 1;
  }

  createBatch(args: {
    batchId?: string;
    featureId: string;
    runId?: string;
    ordinal: number;
    state: SelfModBatchRecord["state"];
    commitHash?: string;
    files: string[];
    blockedFiles?: string[];
    packageId?: string;
    releaseNumber?: number;
  }): SelfModBatchRecord {
    const batchId = args.batchId ?? `batch:${generateLocalId()}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO self_mod_batches (
        batch_id,
        feature_id,
        run_id,
        ordinal,
        state,
        commit_hash,
        files_json,
        blocked_files_json,
        package_id,
        release_number,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      args.featureId,
      args.runId ?? null,
      args.ordinal,
      args.state,
      args.commitHash ?? null,
      JSON.stringify(args.files),
      args.blockedFiles && args.blockedFiles.length > 0
        ? JSON.stringify(args.blockedFiles)
        : null,
      args.packageId ?? null,
      args.releaseNumber ?? null,
      now,
      now,
    );
    return {
      batchId,
      featureId: args.featureId,
      ...(args.runId ? { runId: args.runId } : {}),
      ordinal: args.ordinal,
      state: args.state,
      ...(args.commitHash ? { commitHash: args.commitHash } : {}),
      files: [...args.files],
      ...(args.blockedFiles && args.blockedFiles.length > 0 ? { blockedFiles: [...args.blockedFiles] } : {}),
      ...(args.packageId ? { packageId: args.packageId } : {}),
      ...(args.releaseNumber == null ? {} : { releaseNumber: args.releaseNumber }),
      createdAt: now,
      updatedAt: now,
    };
  }

  listBatches(featureId: string): SelfModBatchRecord[] {
    const rows = this.db.prepare(`
      SELECT
        batch_id AS batchId,
        feature_id AS featureId,
        run_id AS runId,
        ordinal,
        state,
        commit_hash AS commitHash,
        files_json AS filesJson,
        blocked_files_json AS blockedFilesJson,
        package_id AS packageId,
        release_number AS releaseNumber,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM self_mod_batches
      WHERE feature_id = ?
      ORDER BY ordinal ASC, created_at ASC
    `).all(featureId) as BatchRow[];
    return rows.map(toBatchRecord);
  }

  listPendingPublishBatches(featureId: string): SelfModBatchRecord[] {
    return this.listBatches(featureId).filter((batch) => batch.state === "committed");
  }

  markBatchesPublished(args: {
    featureId: string;
    batchIds: string[];
    packageId: string;
    releaseNumber: number;
  }): void {
    if (args.batchIds.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE self_mod_batches
      SET
        state = 'published',
        package_id = ?,
        release_number = ?,
        updated_at = ?
      WHERE batch_id = ?
        AND feature_id = ?
    `);
    for (const batchId of args.batchIds) {
      stmt.run(args.packageId, args.releaseNumber, now, batchId, args.featureId);
    }
    this.bindFeaturePackage(args.featureId, args.packageId);
  }

  recordInstallCommit(args: {
    packageId: string;
    featureId: string;
    releaseNumber: number;
    applyCommitHash: string;
  }): InstalledStoreModRecord {
    const existing = this.getInstalledModByPackageId(args.packageId);
    const now = Date.now();
    if (!existing) {
      const installId = `install:${generateLocalId()}`;
      const applyCommitHashes = [args.applyCommitHash];
      this.db.prepare(`
        INSERT INTO store_mod_installs (
          install_id,
          package_id,
          feature_id,
          release_number,
          apply_commit_hashes_json,
          state,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'installed', ?, ?)
      `).run(
        installId,
        args.packageId,
        args.featureId,
        args.releaseNumber,
        JSON.stringify(applyCommitHashes),
        now,
        now,
      );
      return {
        installId,
        packageId: args.packageId,
        featureId: args.featureId,
        releaseNumber: args.releaseNumber,
        applyCommitHashes,
        state: "installed",
        createdAt: now,
        updatedAt: now,
      };
    }

    const applyCommitHashes = [...existing.applyCommitHashes, args.applyCommitHash];
    this.db.prepare(`
      UPDATE store_mod_installs
      SET
        feature_id = ?,
        release_number = ?,
        apply_commit_hashes_json = ?,
        state = 'installed',
        updated_at = ?
      WHERE install_id = ?
    `).run(
      args.featureId,
      args.releaseNumber,
      JSON.stringify(applyCommitHashes),
      now,
      existing.installId,
    );
    return {
      ...existing,
      featureId: args.featureId,
      releaseNumber: args.releaseNumber,
      applyCommitHashes,
      state: "installed",
      updatedAt: now,
    };
  }

  getInstalledModByPackageId(packageId: string): InstalledStoreModRecord | null {
    const row = this.db.prepare(`
      SELECT
        install_id AS installId,
        package_id AS packageId,
        feature_id AS featureId,
        release_number AS releaseNumber,
        apply_commit_hashes_json AS applyCommitHashesJson,
        state,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM store_mod_installs
      WHERE package_id = ?
      LIMIT 1
    `).get(packageId) as InstallRow | undefined;
    return row ? toInstallRecord(row) : null;
  }

  listInstalledMods(): InstalledStoreModRecord[] {
    const rows = this.db.prepare(`
      SELECT
        install_id AS installId,
        package_id AS packageId,
        feature_id AS featureId,
        release_number AS releaseNumber,
        apply_commit_hashes_json AS applyCommitHashesJson,
        state,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM store_mod_installs
      ORDER BY updated_at DESC, install_id ASC
    `).all() as InstallRow[];
    return rows.map(toInstallRecord);
  }

  markInstallUninstalled(installId: string): void {
    this.db.prepare(`
      UPDATE store_mod_installs
      SET state = 'uninstalled', updated_at = ?
      WHERE install_id = ?
    `).run(Date.now(), installId);
  }
}
