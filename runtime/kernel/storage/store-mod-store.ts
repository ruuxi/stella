import crypto from "node:crypto";
import type {
  SelfModFeatureSnapshot,
  SelfModFeatureSnapshotItem,
  StoreInstallRecord,
  StoreThreadMessage,
  StoreThreadSnapshot,
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
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM store_thread_messages WHERE id IN (${placeholders})`)
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
      throw new Error("Only the latest publishable blueprint can be marked published.");
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
