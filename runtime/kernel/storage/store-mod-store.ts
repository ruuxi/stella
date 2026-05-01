import type {
  SelfModFeatureSnapshot,
  SelfModFeatureSnapshotItem,
  StoreInstallRecord,
} from "../../contracts/index.js";
import type { SqliteDatabase } from "./shared.js";

type InstallRow = {
  packageId: string;
  releaseNumber: number;
  installCommitHash: string | null;
  installCommitHashesJson: string;
  installedAt: number;
};

type SnapshotRow = {
  itemsJson: string;
  generatedAt: number;
};

const parseSnapshotItems = (raw: string): SelfModFeatureSnapshotItem[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): SelfModFeatureSnapshotItem | null => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as Record<string, unknown>;
        const name =
          typeof candidate.name === "string" ? candidate.name.trim() : "";
        if (!name) return null;
        const commitHashes = Array.isArray(candidate.commitHashes)
          ? candidate.commitHashes.filter(
              (hash): hash is string =>
                typeof hash === "string" && hash.trim().length > 0,
            )
          : [];
        return { name, commitHashes };
      })
      .filter((item): item is SelfModFeatureSnapshotItem => item !== null);
  } catch {
    return [];
  }
};

const parseCommitHashes = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((hash): hash is string => typeof hash === "string")
      .map((hash) => hash.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const uniqueCommitHashes = (hashes: string[]): string[] =>
  Array.from(new Set(hashes.map((hash) => hash.trim()).filter(Boolean)));

const toInstallRecord = (row: InstallRow): StoreInstallRecord => {
  const installCommitHashes = uniqueCommitHashes([
    ...parseCommitHashes(row.installCommitHashesJson),
    ...(row.installCommitHash ? [row.installCommitHash] : []),
  ]);
  return {
    packageId: row.packageId,
    releaseNumber: row.releaseNumber,
    installCommitHash:
      row.installCommitHash ??
      installCommitHashes[installCommitHashes.length - 1] ??
      null,
    installCommitHashes,
    installedAt: row.installedAt,
  };
};

/**
 * Persists Store install bookkeeping plus the rolling feature snapshot
 * the side panel renders. No commit history, no per-feature index — the
 * snapshot is regenerated wholesale by the namer LLM after every
 * self-mod commit.
 */
export class StoreModStore {
  constructor(private readonly db: SqliteDatabase) {}

  recordInstall(args: {
    packageId: string;
    releaseNumber: number;
    installCommitHash: string | null;
    installedAt?: number;
  }): StoreInstallRecord {
    const installedAt = args.installedAt ?? Date.now();
    const existing = this.getInstall(args.packageId);
    const installCommitHashes = uniqueCommitHashes([
      ...(existing?.installCommitHashes ?? []),
      ...(args.installCommitHash ? [args.installCommitHash] : []),
    ]);
    this.db
      .prepare(
        `
      INSERT INTO store_installs (
        package_id,
        release_number,
        install_commit_hash,
        install_commit_hashes_json,
        installed_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        release_number = excluded.release_number,
        install_commit_hash = excluded.install_commit_hash,
        install_commit_hashes_json = excluded.install_commit_hashes_json,
        installed_at = excluded.installed_at
    `,
      )
      .run(
        args.packageId,
        args.releaseNumber,
        args.installCommitHash,
        JSON.stringify(installCommitHashes),
        installedAt,
      );
    return {
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      installCommitHash: args.installCommitHash,
      installCommitHashes,
      installedAt,
    };
  }

  getInstall(packageId: string): StoreInstallRecord | null {
    const row = this.db
      .prepare(
        `
      SELECT
        package_id AS packageId,
        release_number AS releaseNumber,
        install_commit_hash AS installCommitHash,
        install_commit_hashes_json AS installCommitHashesJson,
        installed_at AS installedAt
      FROM store_installs
      WHERE package_id = ?
      LIMIT 1
    `,
      )
      .get(packageId) as InstallRow | undefined;
    return row ? toInstallRecord(row) : null;
  }

  listInstalls(): StoreInstallRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        package_id AS packageId,
        release_number AS releaseNumber,
        install_commit_hash AS installCommitHash,
        install_commit_hashes_json AS installCommitHashesJson,
        installed_at AS installedAt
      FROM store_installs
      ORDER BY installed_at DESC, package_id ASC
    `,
      )
      .all() as InstallRow[];
    return rows.map(toInstallRecord);
  }

  deleteInstall(packageId: string): void {
    this.db
      .prepare("DELETE FROM store_installs WHERE package_id = ?")
      .run(packageId);
  }

  writeFeatureSnapshot(snapshot: SelfModFeatureSnapshot): void {
    this.db
      .prepare(
        `
      INSERT INTO self_mod_feature_snapshot (id, items_json, generated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        items_json = excluded.items_json,
        generated_at = excluded.generated_at
    `,
      )
      .run(JSON.stringify(snapshot.items), snapshot.generatedAt);
  }

  readFeatureSnapshot(): SelfModFeatureSnapshot | null {
    const row = this.db
      .prepare(
        `
      SELECT items_json AS itemsJson, generated_at AS generatedAt
      FROM self_mod_feature_snapshot
      WHERE id = 1
      LIMIT 1
    `,
      )
      .get() as SnapshotRow | undefined;
    if (!row) return null;
    return {
      items: parseSnapshotItems(row.itemsJson),
      generatedAt: row.generatedAt,
    };
  }
}
