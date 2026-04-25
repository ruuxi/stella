import type { InstalledStoreModRecord } from "../../contracts/index.js";
import type { SqliteDatabase } from "./shared.js";
import { generateLocalId } from "./shared.js";

type InstallRow = {
  installId: string;
  packageId: string;
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
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
  } catch {
    return [];
  }
};

const toInstallRecord = (row: InstallRow): InstalledStoreModRecord => ({
  installId: row.installId,
  packageId: row.packageId,
  releaseNumber: row.releaseNumber,
  applyCommitHashes: parseJsonStringArray(row.applyCommitHashesJson),
  state: row.state,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Persists per-package install bookkeeping for store-installed mods.
 *
 * Earlier revisions of this store also tracked locally-authored
 * "features" and per-feature "batches" so a future Publish flow could
 * group them. Phase 3 removed that scheme — the Store agent picks raw
 * commits from `git log` at publish time instead — leaving only the
 * install ledger here.
 */
export class StoreModStore {
  constructor(private readonly db: SqliteDatabase) {}

  recordInstallCommit(args: {
    packageId: string;
    releaseNumber: number;
    applyCommitHash: string;
  }): InstalledStoreModRecord {
    const existing = this.getInstalledModByPackageId(args.packageId);
    const now = Date.now();
    if (!existing) {
      const installId = `install:${generateLocalId()}`;
      const applyCommitHashes = [args.applyCommitHash];
      this.db
        .prepare(
          `
        INSERT INTO store_mod_installs (
          install_id,
          package_id,
          release_number,
          apply_commit_hashes_json,
          state,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'installed', ?, ?)
      `,
        )
        .run(
          installId,
          args.packageId,
          args.releaseNumber,
          JSON.stringify(applyCommitHashes),
          now,
          now,
        );
      return {
        installId,
        packageId: args.packageId,
        releaseNumber: args.releaseNumber,
        applyCommitHashes,
        state: "installed",
        createdAt: now,
        updatedAt: now,
      };
    }

    const applyCommitHashes = [
      ...existing.applyCommitHashes,
      args.applyCommitHash,
    ];
    this.db
      .prepare(
        `
      UPDATE store_mod_installs
      SET
        release_number = ?,
        apply_commit_hashes_json = ?,
        state = 'installed',
        updated_at = ?
      WHERE install_id = ?
    `,
      )
      .run(
        args.releaseNumber,
        JSON.stringify(applyCommitHashes),
        now,
        existing.installId,
      );
    return {
      ...existing,
      releaseNumber: args.releaseNumber,
      applyCommitHashes,
      state: "installed",
      updatedAt: now,
    };
  }

  getInstalledModByPackageId(packageId: string): InstalledStoreModRecord | null {
    const row = this.db
      .prepare(
        `
      SELECT
        install_id AS installId,
        package_id AS packageId,
        release_number AS releaseNumber,
        apply_commit_hashes_json AS applyCommitHashesJson,
        state,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM store_mod_installs
      WHERE package_id = ?
      LIMIT 1
    `,
      )
      .get(packageId) as InstallRow | undefined;
    return row ? toInstallRecord(row) : null;
  }

  listInstalledMods(): InstalledStoreModRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        install_id AS installId,
        package_id AS packageId,
        release_number AS releaseNumber,
        apply_commit_hashes_json AS applyCommitHashesJson,
        state,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM store_mod_installs
      ORDER BY updated_at DESC, install_id ASC
    `,
      )
      .all() as InstallRow[];
    return rows.map(toInstallRecord);
  }

  markInstallUninstalled(installId: string): void {
    this.db
      .prepare(
        `
      UPDATE store_mod_installs
      SET state = 'uninstalled', updated_at = ?
      WHERE install_id = ?
    `,
      )
      .run(Date.now(), installId);
  }
}
