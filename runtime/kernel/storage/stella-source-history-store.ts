import type { StellaSourceChangeSet } from "../self-mod/stella-source-control.js";
import { stripStellaSourceChangeSetContent } from "../self-mod/stella-source-control.js";
import type { SqliteDatabase } from "./shared.js";

export type StellaSourceRevisionOrigin =
  | "self-mod"
  | "store-install"
  | "store-update"
  | "store-uninstall"
  | "desktop-update"
  | "official";

export type StellaSourceRevisionRecord = {
  revisionId: string;
  baseRevisionId: string;
  parentRevisionIds: string[];
  featureId?: string;
  description?: string;
  origin: StellaSourceRevisionOrigin;
  commitHash?: string;
  packageId?: string;
  releaseNumber?: number;
  changeSet: StellaSourceChangeSet;
  createdAt: number;
};

type SourceRevisionRow = {
  revisionId: string;
  baseRevisionId: string;
  parentRevisionIdsJson: string;
  featureId: string | null;
  description: string | null;
  origin: StellaSourceRevisionOrigin;
  commitHash: string | null;
  packageId: string | null;
  releaseNumber: number | null;
  changeSetJson: string;
  createdAt: number;
};

const parseStringArray = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const parseChangeSet = (raw: string): StellaSourceChangeSet | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as StellaSourceChangeSet;
    if (candidate.schemaVersion !== 1 || !candidate.revisionId) return null;
    return stripStellaSourceChangeSetContent(candidate);
  } catch {
    return null;
  }
};

const asTrimmed = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const asCommitHash = (value: string | null | undefined): string | undefined =>
  asTrimmed(value);

const normalizeParentRevisionIds = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const toRecord = (
  row: SourceRevisionRow,
): StellaSourceRevisionRecord | null => {
  const changeSet = parseChangeSet(row.changeSetJson);
  if (!changeSet) return null;
  const parentRevisionIds = normalizeParentRevisionIds(
    parseStringArray(row.parentRevisionIdsJson),
  );
  return {
    revisionId: row.revisionId,
    baseRevisionId: row.baseRevisionId,
    parentRevisionIds,
    ...(row.featureId ? { featureId: row.featureId } : {}),
    ...(row.description ? { description: row.description } : {}),
    origin: row.origin,
    ...(row.commitHash ? { commitHash: row.commitHash } : {}),
    ...(row.packageId ? { packageId: row.packageId } : {}),
    ...(typeof row.releaseNumber === "number"
      ? { releaseNumber: row.releaseNumber }
      : {}),
    changeSet,
    createdAt: row.createdAt,
  };
};

export class StellaSourceHistoryStore {
  constructor(private readonly db: SqliteDatabase) {}

  recordRevision(args: {
    changeSet: StellaSourceChangeSet;
    origin: StellaSourceRevisionOrigin;
    commitHash?: string | null;
    packageId?: string | null;
    releaseNumber?: number | null;
    featureId?: string | null;
    description?: string | null;
    createdAt?: number;
  }): StellaSourceRevisionRecord {
    const changeSet = stripStellaSourceChangeSetContent(args.changeSet);
    const existing = this.getRevision(changeSet.revisionId);
    const featureId = asTrimmed(args.featureId) ?? changeSet.featureId;
    const description = asTrimmed(args.description) ?? changeSet.description;
    const parentRevisionIds = normalizeParentRevisionIds(
      changeSet.parentRevisionIds,
    );
    const createdAt = args.createdAt ?? Date.now();
    this.db
      .prepare(
        `
      INSERT INTO stella_source_revisions (
        revision_id,
        base_revision_id,
        parent_revision_ids_json,
        feature_id,
        description,
        origin,
        commit_hash,
        package_id,
        release_number,
        change_set_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(revision_id) DO UPDATE SET
        base_revision_id = excluded.base_revision_id,
        parent_revision_ids_json = excluded.parent_revision_ids_json,
        feature_id = excluded.feature_id,
        description = excluded.description,
        origin = excluded.origin,
        commit_hash = excluded.commit_hash,
        package_id = excluded.package_id,
        release_number = excluded.release_number,
        change_set_json = excluded.change_set_json,
        created_at = excluded.created_at
    `,
      )
      .run(
        changeSet.revisionId,
        changeSet.baseRevisionId,
        JSON.stringify(parentRevisionIds),
        featureId ?? null,
        description ?? null,
        args.origin,
        asCommitHash(args.commitHash) ?? null,
        asTrimmed(args.packageId) ?? null,
        typeof args.releaseNumber === "number"
          ? Math.max(1, Math.floor(args.releaseNumber))
          : null,
        JSON.stringify(changeSet),
        createdAt,
      );
    this.recordCommitAliases({
      revisionId: changeSet.revisionId,
      commitHashes: [
        ...(existing?.commitHash ? [existing.commitHash] : []),
        ...(args.commitHash ? [args.commitHash] : []),
      ],
      createdAt,
    });
    return {
      revisionId: changeSet.revisionId,
      baseRevisionId: changeSet.baseRevisionId,
      parentRevisionIds,
      ...(featureId ? { featureId } : {}),
      ...(description ? { description } : {}),
      origin: args.origin,
      ...(asTrimmed(args.commitHash)
        ? { commitHash: asCommitHash(args.commitHash)! }
        : {}),
      ...(asTrimmed(args.packageId)
        ? { packageId: asTrimmed(args.packageId) }
        : {}),
      ...(typeof args.releaseNumber === "number"
        ? { releaseNumber: Math.max(1, Math.floor(args.releaseNumber)) }
        : {}),
      changeSet,
      createdAt,
    };
  }

  private recordCommitAliases(args: {
    revisionId: string;
    commitHashes: string[];
    createdAt: number;
  }): void {
    const hashes = Array.from(
      new Set(args.commitHashes.map(asCommitHash).filter(Boolean)),
    );
    for (const hash of hashes) {
      this.db
        .prepare(
          `
      INSERT INTO stella_source_revision_commits (
        commit_hash,
        revision_id,
        created_at
      )
      VALUES (?, ?, ?)
      ON CONFLICT(commit_hash) DO UPDATE SET
        revision_id = excluded.revision_id,
        created_at = excluded.created_at
    `,
        )
        .run(hash, args.revisionId, args.createdAt);
    }
  }

  getRevision(revisionId: string): StellaSourceRevisionRecord | null {
    const id = revisionId.trim();
    if (!id) return null;
    const row = this.db
      .prepare(
        `
      SELECT
        revision_id AS revisionId,
        base_revision_id AS baseRevisionId,
        parent_revision_ids_json AS parentRevisionIdsJson,
        feature_id AS featureId,
        description,
        origin,
        commit_hash AS commitHash,
        package_id AS packageId,
        release_number AS releaseNumber,
        change_set_json AS changeSetJson,
        created_at AS createdAt
      FROM stella_source_revisions
      WHERE revision_id = ?
      LIMIT 1
    `,
      )
      .get(id) as SourceRevisionRow | undefined;
    return row ? toRecord(row) : null;
  }

  findRevisionByCommit(
    commitHash: string | null | undefined,
  ): StellaSourceRevisionRecord | null {
    const hash = commitHash?.trim();
    if (!hash) return null;
    const row = this.db
      .prepare(
        `
      SELECT
        revisions.revision_id AS revisionId,
        revisions.base_revision_id AS baseRevisionId,
        revisions.parent_revision_ids_json AS parentRevisionIdsJson,
        revisions.feature_id AS featureId,
        revisions.description,
        revisions.origin,
        revisions.commit_hash AS commitHash,
        revisions.package_id AS packageId,
        revisions.release_number AS releaseNumber,
        revisions.change_set_json AS changeSetJson,
        revisions.created_at AS createdAt
      FROM stella_source_revisions revisions
      JOIN stella_source_revision_commits aliases
        ON aliases.revision_id = revisions.revision_id
      WHERE aliases.commit_hash = ?
      LIMIT 1
    `,
      )
      .get(hash) as SourceRevisionRow | undefined;
    if (row) return toRecord(row);
    const fallbackRow = this.db
      .prepare(
        `
      SELECT
        revision_id AS revisionId,
        base_revision_id AS baseRevisionId,
        parent_revision_ids_json AS parentRevisionIdsJson,
        feature_id AS featureId,
        description,
        origin,
        commit_hash AS commitHash,
        package_id AS packageId,
        release_number AS releaseNumber,
        change_set_json AS changeSetJson,
        created_at AS createdAt
      FROM stella_source_revisions
      WHERE commit_hash = ?
      LIMIT 1
    `,
      )
      .get(hash) as SourceRevisionRow | undefined;
    return fallbackRow ? toRecord(fallbackRow) : null;
  }

  listRecentRevisions(limit = 50): StellaSourceRevisionRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `
      SELECT
        revision_id AS revisionId,
        base_revision_id AS baseRevisionId,
        parent_revision_ids_json AS parentRevisionIdsJson,
        feature_id AS featureId,
        description,
        origin,
        commit_hash AS commitHash,
        package_id AS packageId,
        release_number AS releaseNumber,
        change_set_json AS changeSetJson,
        created_at AS createdAt
      FROM stella_source_revisions
      ORDER BY created_at DESC, revision_id DESC
      LIMIT ?
    `,
      )
      .all(safeLimit) as SourceRevisionRow[];
    return rows
      .map(toRecord)
      .filter(
        (record): record is StellaSourceRevisionRecord => record !== null,
      );
  }

  listFeatureRevisions(featureId: string): StellaSourceRevisionRecord[] {
    const id = featureId.trim();
    if (!id) return [];
    const rows = this.db
      .prepare(
        `
      SELECT
        revision_id AS revisionId,
        base_revision_id AS baseRevisionId,
        parent_revision_ids_json AS parentRevisionIdsJson,
        feature_id AS featureId,
        description,
        origin,
        commit_hash AS commitHash,
        package_id AS packageId,
        release_number AS releaseNumber,
        change_set_json AS changeSetJson,
        created_at AS createdAt
      FROM stella_source_revisions
      WHERE feature_id = ?
      ORDER BY created_at ASC, revision_id ASC
    `,
      )
      .all(id) as SourceRevisionRow[];
    return rows
      .map(toRecord)
      .filter(
        (record): record is StellaSourceRevisionRecord => record !== null,
      );
  }
}
