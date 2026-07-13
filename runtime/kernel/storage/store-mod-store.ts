import crypto from "node:crypto";
import type {
  SelfModFeatureRosterEntry,
  SelfModFeatureSnapshot,
  SelfModFeatureSnapshotItem,
  StoreInstallRecord,
  StoreThreadMessage,
  StoreThreadSnapshot,
} from "../../contracts/index.js";
import { slugify } from "../shared/slug.js";
import type { SqliteDatabase } from "./shared.js";

type InstallRow = {
  packageId: string;
  releaseNumber: number;
  installCommitHash: string | null;
  installCommitHashesJson: string;
  sourceRevisionId: string | null;
  sourceRevisionIdsJson: string;
  installedAt: number;
};

type SnapshotRow = {
  itemsJson: string;
  generatedAt: number;
};

type StoreThreadMessageRow = {
  id: string;
  role: StoreThreadMessage["role"];
  text: string;
  isBlueprint: number;
  denied: number;
  published: number;
  publishedReleaseNumber: number | null;
  pending: number;
  attachedFeatureNamesJson: string;
  editingBlueprint: number;
  createdAt: number;
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
        const featureId =
          typeof candidate.featureId === "string" && candidate.featureId.trim()
            ? candidate.featureId.trim()
            : undefined;
        return { name, commitHashes, ...(featureId ? { featureId } : {}) };
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

const uniqueStringIds = (ids: string[]): string[] =>
  Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));

const parseStringArray = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
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

const toInstallRecord = (row: InstallRow): StoreInstallRecord => {
  const installCommitHashes = uniqueCommitHashes([
    ...parseCommitHashes(row.installCommitHashesJson),
    ...(row.installCommitHash ? [row.installCommitHash] : []),
  ]);
  const sourceRevisionIds = uniqueStringIds([
    ...parseStringArray(row.sourceRevisionIdsJson),
    ...(row.sourceRevisionId ? [row.sourceRevisionId] : []),
  ]);
  return {
    packageId: row.packageId,
    releaseNumber: row.releaseNumber,
    installCommitHash:
      row.installCommitHash ??
      installCommitHashes[installCommitHashes.length - 1] ??
      null,
    installCommitHashes,
    sourceRevisionId:
      row.sourceRevisionId ??
      sourceRevisionIds[sourceRevisionIds.length - 1] ??
      null,
    sourceRevisionIds,
    installedAt: row.installedAt,
  };
};

const toStoreThreadMessage = (
  row: StoreThreadMessageRow,
): StoreThreadMessage => ({
  _id: row.id,
  role: row.role,
  text: row.text,
  ...(row.isBlueprint ? { isBlueprint: true } : {}),
  ...(row.denied ? { denied: true } : {}),
  ...(row.published ? { published: true } : {}),
  ...(typeof row.publishedReleaseNumber === "number"
    ? { publishedReleaseNumber: row.publishedReleaseNumber }
    : {}),
  ...(row.pending ? { pending: true } : {}),
  ...(row.editingBlueprint ? { editingBlueprint: true } : {}),
  attachedFeatureNames: parseStringArray(row.attachedFeatureNamesJson),
  createdAt: row.createdAt,
});

/**
 * Persists Store install bookkeeping plus the rolling feature snapshot
 * the side panel renders. No commit history, no per-feature index — the
 * snapshot is regenerated wholesale by the namer LLM after every
 * self-mod commit.
 *
 * The optional thread-updated listener (set via
 * `setThreadUpdatedListener`) fires after every mutation to the store
 * thread (append/patch/clear/delete/deny/markPublished) so the worker
 * server can push a fresh snapshot to subscribers instead of forcing
 * the renderer to poll.
 */
export class StoreModStore {
  private threadUpdatedListener: (() => void) | null = null;

  constructor(private readonly db: SqliteDatabase) {}

  setThreadUpdatedListener(listener: (() => void) | null): void {
    this.threadUpdatedListener = listener;
  }

  private notifyThreadUpdated(): void {
    const listener = this.threadUpdatedListener;
    if (!listener) return;
    try {
      listener();
    } catch (error) {
      console.warn(
        "[store-mod-store] threadUpdatedListener threw:",
        (error as Error).message,
      );
    }
  }

  recordInstall(args: {
    packageId: string;
    releaseNumber: number;
    installCommitHash: string | null;
    sourceRevisionId?: string | null;
    sourceRevisionIds?: string[];
    installedAt?: number;
  }): StoreInstallRecord {
    const installedAt = args.installedAt ?? Date.now();
    const existing = this.getInstall(args.packageId);
    const installCommitHashes = uniqueCommitHashes([
      ...(existing?.installCommitHashes ?? []),
      ...(args.installCommitHash ? [args.installCommitHash] : []),
    ]);
    const latestInstallCommitHash =
      args.installCommitHash ?? existing?.installCommitHash ?? null;
    const sourceRevisionIds = uniqueStringIds([
      ...(existing?.sourceRevisionIds ?? []),
      ...(args.sourceRevisionIds ?? []),
      ...(args.sourceRevisionId ? [args.sourceRevisionId] : []),
    ]);
    const latestSourceRevisionId =
      args.sourceRevisionId ??
      args.sourceRevisionIds?.[args.sourceRevisionIds.length - 1] ??
      existing?.sourceRevisionId ??
      null;
    this.db
      .prepare(
        `
      INSERT INTO store_installs (
        package_id,
        release_number,
        install_commit_hash,
        install_commit_hashes_json,
        source_revision_id,
        source_revision_ids_json,
        installed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        release_number = excluded.release_number,
        install_commit_hash = excluded.install_commit_hash,
        install_commit_hashes_json = excluded.install_commit_hashes_json,
        source_revision_id = excluded.source_revision_id,
        source_revision_ids_json = excluded.source_revision_ids_json,
        installed_at = excluded.installed_at
    `,
      )
      .run(
        args.packageId,
        args.releaseNumber,
        latestInstallCommitHash,
        JSON.stringify(installCommitHashes),
        latestSourceRevisionId,
        JSON.stringify(sourceRevisionIds),
        installedAt,
      );
    return {
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      installCommitHash: latestInstallCommitHash,
      installCommitHashes,
      sourceRevisionId: latestSourceRevisionId,
      sourceRevisionIds,
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
        source_revision_id AS sourceRevisionId,
        source_revision_ids_json AS sourceRevisionIdsJson,
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
        source_revision_id AS sourceRevisionId,
        source_revision_ids_json AS sourceRevisionIdsJson,
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

  /**
   * Record one self-mod commit against its durable feature. The
   * feature's name is FROZEN at first commit (write-once, no churn);
   * later commits only bump recency and the commit list. commit_count
   * is derived from the commit table so re-recording a hash is
   * idempotent.
   */
  upsertFeatureRosterEntry(args: {
    featureId: string;
    name: string;
    conversationId?: string;
    commitHash: string;
    committedAt?: number;
  }): void {
    const committedAt = args.committedAt ?? Date.now();
    this.db
      .prepare(
        `
      INSERT INTO store_feature_roster (
        feature_id, name, conversation_id, created_at, last_commit_at, commit_count
      )
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(feature_id) DO UPDATE SET
        last_commit_at = MAX(last_commit_at, excluded.last_commit_at)
    `,
      )
      .run(
        args.featureId,
        args.name.trim() || args.featureId,
        args.conversationId ?? null,
        committedAt,
        committedAt,
      );
    this.db
      .prepare(
        `
      INSERT INTO store_feature_commits (feature_id, commit_hash, committed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(feature_id, commit_hash) DO NOTHING
    `,
      )
      .run(args.featureId, args.commitHash, committedAt);
    this.db
      .prepare(
        `
      UPDATE store_feature_roster
      SET commit_count = (
        SELECT COUNT(*) FROM store_feature_commits WHERE feature_id = ?
      )
      WHERE feature_id = ?
    `,
      )
      .run(args.featureId, args.featureId);
  }

  listFeatureRoster(args?: {
    limit?: number;
    offset?: number;
  }): SelfModFeatureRosterEntry[] {
    const limit = Math.max(1, Math.min(200, Math.floor(args?.limit ?? 50)));
    const offset = Math.max(0, Math.floor(args?.offset ?? 0));
    const rows = this.db
      .prepare(
        `
      SELECT
        feature_id AS featureId,
        name,
        conversation_id AS conversationId,
        created_at AS createdAt,
        last_commit_at AS lastCommitAt,
        commit_count AS commitCount
      FROM store_feature_roster
      ORDER BY last_commit_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(limit, offset) as Array<{
      featureId: string;
      name: string;
      conversationId: string | null;
      createdAt: number;
      lastCommitAt: number;
      commitCount: number;
    }>;
    return rows.map((row) => ({
      featureId: row.featureId,
      name: row.name,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      createdAt: row.createdAt,
      lastCommitAt: row.lastCommitAt,
      commitCount: row.commitCount,
    }));
  }

  countFeatureRoster(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM store_feature_roster")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listFeatureCommitHashes(featureId: string): string[] {
    const rows = this.db
      .prepare(
        `
      SELECT commit_hash AS commitHash
      FROM store_feature_commits
      WHERE feature_id = ?
      ORDER BY committed_at DESC
    `,
      )
      .all(featureId) as Array<{ commitHash: string }>;
    return rows.map((row) => row.commitHash);
  }

  /**
   * Materialize the snapshot the Store side panel (and the publish
   * flow) reads from the roster head — same contract shape the LLM
   * regenerator used to produce, now deterministic and durable.
   */
  buildSnapshotFromRoster(limit = 20): SelfModFeatureSnapshot {
    const items = this.listFeatureRoster({ limit }).map((entry) => ({
      name: entry.name,
      commitHashes: this.listFeatureCommitHashes(entry.featureId),
      featureId: entry.featureId,
    }));
    return { items, generatedAt: Date.now() };
  }

  /**
   * One-time import: when the roster is empty but a pre-roster LLM
   * snapshot exists, freeze its items as `legacy-…` features so
   * nothing the user currently sees disappears. Names are frozen
   * as-is; older commits beyond the imported window stay git-only.
   */
  seedFeatureRosterFromSnapshotIfEmpty(): void {
    if (this.countFeatureRoster() > 0) return;
    const snapshot = this.readFeatureSnapshot();
    if (!snapshot || snapshot.items.length === 0) return;
    // All-or-nothing: a partial seed would pass the count>0 guard on the
    // next startup and permanently drop the un-imported items (the next
    // commit overwrites the snapshot they live in).
    this.db.exec("BEGIN");
    try {
      this.seedFeatureRosterItems(snapshot.items, snapshot.generatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Connection-level failure; nothing further to roll back.
      }
      throw error;
    }
  }

  private seedFeatureRosterItems(
    items: SelfModFeatureSnapshotItem[],
    generatedAt: number,
  ): void {
    const seen = new Set<string>();
    for (const item of items) {
      let featureId = `legacy-${slugify(item.name) || "feature"}`;
      for (let ordinal = 2; seen.has(featureId); ordinal++) {
        featureId = `legacy-${slugify(item.name) || "feature"}-${ordinal}`;
      }
      seen.add(featureId);
      if (item.commitHashes.length === 0) {
        this.db
          .prepare(
            `
          INSERT INTO store_feature_roster (
            feature_id, name, conversation_id, created_at, last_commit_at, commit_count
          )
          VALUES (?, ?, NULL, ?, ?, 0)
          ON CONFLICT(feature_id) DO NOTHING
        `,
          )
          .run(featureId, item.name, generatedAt, generatedAt);
        continue;
      }
      for (const commitHash of item.commitHashes) {
        this.upsertFeatureRosterEntry({
          featureId,
          name: item.name,
          commitHash,
          committedAt: generatedAt,
        });
      }
    }
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

  readStoreThread(): StoreThreadSnapshot {
    return {
      threadId: "local-store-thread",
      messages: this.listStoreThreadMessages(),
    };
  }

  listStoreThreadMessages(): StoreThreadMessage[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        id,
        role,
        text,
        is_blueprint AS isBlueprint,
        denied,
        published,
        published_release_number AS publishedReleaseNumber,
        pending,
        attached_feature_names_json AS attachedFeatureNamesJson,
        editing_blueprint AS editingBlueprint,
        created_at AS createdAt
      FROM store_thread_messages
      ORDER BY created_at ASC, id ASC
    `,
      )
      .all() as StoreThreadMessageRow[];
    return rows.map(toStoreThreadMessage);
  }

  appendStoreThreadMessage(args: {
    id?: string;
    role: StoreThreadMessage["role"];
    text: string;
    isBlueprint?: boolean;
    pending?: boolean;
    denied?: boolean;
    published?: boolean;
    publishedReleaseNumber?: number;
    attachedFeatureNames?: string[];
    editingBlueprint?: boolean;
    createdAt?: number;
  }): StoreThreadMessage {
    const id = args.id ?? `store-msg-${crypto.randomUUID()}`;
    const createdAt = args.createdAt ?? Date.now();
    const attachedFeatureNames = (args.attachedFeatureNames ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    this.db
      .prepare(
        `
      INSERT INTO store_thread_messages (
        id,
        role,
        text,
        is_blueprint,
        denied,
        published,
        published_release_number,
        pending,
        attached_feature_names_json,
        editing_blueprint,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        args.role,
        args.text,
        args.isBlueprint ? 1 : 0,
        args.denied ? 1 : 0,
        args.published ? 1 : 0,
        args.publishedReleaseNumber ?? null,
        args.pending ? 1 : 0,
        JSON.stringify(attachedFeatureNames),
        args.editingBlueprint ? 1 : 0,
        createdAt,
      );
    const result: StoreThreadMessage = {
      _id: id,
      role: args.role,
      text: args.text,
      ...(args.isBlueprint ? { isBlueprint: true } : {}),
      ...(args.denied ? { denied: true } : {}),
      ...(args.published ? { published: true } : {}),
      ...(typeof args.publishedReleaseNumber === "number"
        ? { publishedReleaseNumber: args.publishedReleaseNumber }
        : {}),
      ...(args.pending ? { pending: true } : {}),
      ...(args.editingBlueprint ? { editingBlueprint: true } : {}),
      attachedFeatureNames,
      createdAt,
    };
    this.notifyThreadUpdated();
    return result;
  }

  patchStoreThreadMessage(
    id: string,
    patch: {
      text?: string;
      isBlueprint?: boolean;
      denied?: boolean;
      published?: boolean;
      publishedReleaseNumber?: number | null;
      pending?: boolean;
    },
  ): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.text !== undefined) {
      assignments.push("text = ?");
      values.push(patch.text);
    }
    if (patch.isBlueprint !== undefined) {
      assignments.push("is_blueprint = ?");
      values.push(patch.isBlueprint ? 1 : 0);
    }
    if (patch.denied !== undefined) {
      assignments.push("denied = ?");
      values.push(patch.denied ? 1 : 0);
    }
    if (patch.published !== undefined) {
      assignments.push("published = ?");
      values.push(patch.published ? 1 : 0);
    }
    if (patch.publishedReleaseNumber !== undefined) {
      assignments.push("published_release_number = ?");
      values.push(patch.publishedReleaseNumber);
    }
    if (patch.pending !== undefined) {
      assignments.push("pending = ?");
      values.push(patch.pending ? 1 : 0);
    }
    if (assignments.length === 0) return;
    values.push(id);
    this.db
      .prepare(
        `UPDATE store_thread_messages SET ${assignments.join(", ")} WHERE id = ?`,
      )
      .run(...values);
    this.notifyThreadUpdated();
  }

  clearPendingStoreThreadMessages(text: string): void {
    this.db
      .prepare(
        `
      UPDATE store_thread_messages
      SET text = ?, pending = 0
      WHERE pending = 1
    `,
      )
      .run(text);
    this.notifyThreadUpdated();
  }

  deleteStoreThreadMessages(ids: string[]): void {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM store_thread_messages WHERE id IN (${placeholders})`,
      )
      .run(...uniqueIds);
    this.notifyThreadUpdated();
  }

  findLatestPublishableBlueprint(): StoreThreadMessage | null {
    const row = this.db
      .prepare(
        `
      SELECT
        id,
        role,
        text,
        is_blueprint AS isBlueprint,
        denied,
        published,
        published_release_number AS publishedReleaseNumber,
        pending,
        attached_feature_names_json AS attachedFeatureNamesJson,
        editing_blueprint AS editingBlueprint,
        created_at AS createdAt
      FROM store_thread_messages
      WHERE role = 'assistant'
        AND is_blueprint = 1
        AND denied = 0
        AND published = 0
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
      )
      .get() as StoreThreadMessageRow | undefined;
    return row ? toStoreThreadMessage(row) : null;
  }

  denyLatestPublishableBlueprint(): StoreThreadMessage | null {
    const latest = this.findLatestPublishableBlueprint();
    if (!latest) return null;
    this.patchStoreThreadMessage(latest._id, { denied: true });
    return { ...latest, denied: true };
  }

  markLatestPublishableBlueprintPublished(args: {
    messageId: string;
    releaseNumber: number;
  }): StoreThreadMessage {
    const latest = this.findLatestPublishableBlueprint();
    if (!latest || latest._id !== args.messageId) {
      throw new Error(
        "Only the latest publishable blueprint can be marked published.",
      );
    }
    this.patchStoreThreadMessage(args.messageId, {
      published: true,
      publishedReleaseNumber: args.releaseNumber,
    });
    return {
      ...latest,
      published: true,
      publishedReleaseNumber: args.releaseNumber,
    };
  }
}
