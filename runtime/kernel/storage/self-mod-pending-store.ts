import type { ApplyResult } from "../self-mod/hmr.js";
import type { SqliteDatabase } from "./shared.js";

export type PersistedPendingSelfModApply = {
  applyId: string;
  commitHash?: string;
  applyResult: ApplyResult;
  conversationId: string;
  files: string[];
  ownerThreadId?: string;
  changeSetId?: string;
  completionEventId?: string;
  assistantMessageEventId?: string;
};

export type PersistedSelfModChangeSet = {
  changeSetId: string;
  conversationId: string;
  ownerThreadId: string;
  completionEventId: string;
  assistantMessageEventId?: string;
  /** Immutable exact commit set captured when the completion is published. */
  commitHashes?: string[];
  status: "published" | "attached" | "applying" | "applied";
};

type ContributionRow = {
  apply_id: string;
  commit_hash: string | null;
  apply_result_json: string;
  conversation_id: string;
  files_json: string;
  owner_thread_id: string | null;
  change_set_id: string | null;
  completion_event_id: string | null;
  assistant_message_event_id: string | null;
};

type ChangeSetRow = {
  change_set_id: string;
  conversation_id: string;
  owner_thread_id: string;
  completion_event_id: string;
  assistant_message_event_id: string | null;
  commit_hashes_json: string | null;
  status: PersistedSelfModChangeSet["status"];
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const parseApplyResult = (value: string): ApplyResult => {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid pending self-mod apply result.");
  }
  const record = parsed as Partial<ApplyResult>;
  if (!Array.isArray(record.appliedRuns)) {
    throw new Error("Invalid pending self-mod appliedRuns.");
  }
  return {
    appliedRuns: record.appliedRuns,
    restartRelevantRunIds: asStringArray(record.restartRelevantRunIds),
    hasRestartRelevantPaths: record.hasRestartRelevantPaths === true,
    hasRuntimeRestartRelevantPaths:
      record.hasRuntimeRestartRelevantPaths === true,
    hasProcessRestartRelevantPaths:
      record.hasProcessRestartRelevantPaths === true,
    hasFullReloadRelevantPaths: record.hasFullReloadRelevantPaths === true,
  };
};

const toContribution = (
  row: ContributionRow,
): PersistedPendingSelfModApply => ({
  applyId: row.apply_id,
  ...(row.commit_hash ? { commitHash: row.commit_hash } : {}),
  applyResult: parseApplyResult(row.apply_result_json),
  conversationId: row.conversation_id,
  files: asStringArray(parseJson(row.files_json)),
  ...(row.owner_thread_id ? { ownerThreadId: row.owner_thread_id } : {}),
  ...(row.change_set_id ? { changeSetId: row.change_set_id } : {}),
  ...(row.completion_event_id
    ? { completionEventId: row.completion_event_id }
    : {}),
  ...(row.assistant_message_event_id
    ? { assistantMessageEventId: row.assistant_message_event_id }
    : {}),
});

const toChangeSet = (row: ChangeSetRow): PersistedSelfModChangeSet => ({
  changeSetId: row.change_set_id,
  conversationId: row.conversation_id,
  ownerThreadId: row.owner_thread_id,
  completionEventId: row.completion_event_id,
  ...(row.assistant_message_event_id
    ? { assistantMessageEventId: row.assistant_message_event_id }
    : {}),
  ...(row.commit_hashes_json
    ? { commitHashes: asStringArray(parseJson(row.commit_hashes_json)) }
    : {}),
  status: row.status,
});

export class SelfModPendingStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly repoRoot: string,
  ) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  recoverInterruptedApplies(): void {
    this.db
      .prepare(
        `
        UPDATE self_mod_pending_change_sets
        SET
          status = CASE
            WHEN assistant_message_event_id IS NULL THEN 'published'
            ELSE 'attached'
          END,
          updated_at = ?
        WHERE repo_root = ? AND status = 'applying'
      `,
      )
      .run(Date.now(), this.repoRoot);
  }

  listPendingContributions(): PersistedPendingSelfModApply[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          contribution.apply_id,
          contribution.commit_hash,
          contribution.apply_result_json,
          contribution.conversation_id,
          contribution.files_json,
          contribution.owner_thread_id,
          contribution.change_set_id,
          contribution.completion_event_id,
          contribution.assistant_message_event_id
        FROM self_mod_pending_contributions AS contribution
        LEFT JOIN self_mod_pending_change_sets AS change_set
          ON change_set.change_set_id = contribution.change_set_id
        WHERE contribution.repo_root = ?
          AND (change_set.status IS NULL OR change_set.status <> 'applied')
        ORDER BY contribution.sequence ASC
      `,
      )
      .all(this.repoRoot) as unknown as ContributionRow[];
    return rows.map(toContribution);
  }

  stageContribution(
    entry: PersistedPendingSelfModApply,
  ): PersistedPendingSelfModApply {
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO self_mod_pending_contributions (
          apply_id,
          repo_root,
          commit_hash,
          apply_result_json,
          conversation_id,
          files_json,
          owner_thread_id,
          change_set_id,
          completion_event_id,
          assistant_message_event_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_root, apply_id) DO UPDATE SET
          commit_hash = excluded.commit_hash,
          apply_result_json = excluded.apply_result_json,
          conversation_id = excluded.conversation_id,
          files_json = excluded.files_json,
          owner_thread_id = excluded.owner_thread_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        entry.applyId,
        this.repoRoot,
        entry.commitHash ?? null,
        JSON.stringify(entry.applyResult),
        entry.conversationId,
        JSON.stringify(entry.files),
        entry.ownerThreadId ?? null,
        entry.changeSetId ?? null,
        entry.completionEventId ?? null,
        entry.assistantMessageEventId ?? null,
        now,
        now,
      );
    const row = this.db
      .prepare(
        `
        SELECT
          apply_id,
          commit_hash,
          apply_result_json,
          conversation_id,
          files_json,
          owner_thread_id,
          change_set_id,
          completion_event_id,
          assistant_message_event_id
        FROM self_mod_pending_contributions
        WHERE apply_id = ? AND repo_root = ?
      `,
      )
      .get(entry.applyId, this.repoRoot) as ContributionRow | undefined;
    if (!row) {
      throw new Error(
        `Failed to persist pending self-mod run ${entry.applyId}.`,
      );
    }
    return toContribution(row);
  }

  publishCompletion(args: {
    conversationId: string;
    ownerThreadId: string;
    completionEventId: string;
  }): {
    changeSet: PersistedSelfModChangeSet;
    contributions: PersistedPendingSelfModApply[];
  } {
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `
          SELECT
            change_set_id,
            conversation_id,
            owner_thread_id,
            completion_event_id,
            assistant_message_event_id,
            commit_hashes_json,
            status
          FROM self_mod_pending_change_sets
          WHERE repo_root = ? AND completion_event_id = ?
          LIMIT 1
        `,
        )
        .get(this.repoRoot, args.completionEventId) as ChangeSetRow | undefined;
      const changeSetId =
        existing?.change_set_id ??
        `self-mod-change-set:${args.completionEventId}`;
      if (
        existing &&
        (existing.conversation_id !== args.conversationId ||
          existing.owner_thread_id !== args.ownerThreadId)
      ) {
        throw new Error(
          `Self-mod completion ${args.completionEventId} is already owned by another thread.`,
        );
      }
      if (!existing) {
        const now = Date.now();
        this.db
          .prepare(
            `
            INSERT INTO self_mod_pending_change_sets (
              change_set_id,
              repo_root,
              conversation_id,
              owner_thread_id,
              completion_event_id,
              status,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?)
          `,
          )
          .run(
            changeSetId,
            this.repoRoot,
            args.conversationId,
            args.ownerThreadId,
            args.completionEventId,
            now,
            now,
          );
        this.db
          .prepare(
            `
            UPDATE self_mod_pending_contributions
            SET
              change_set_id = ?,
              completion_event_id = ?,
              updated_at = ?
            WHERE conversation_id = ?
              AND repo_root = ?
              AND owner_thread_id = ?
              AND change_set_id IS NULL
          `,
          )
          .run(
            changeSetId,
            args.completionEventId,
            now,
            args.conversationId,
            this.repoRoot,
            args.ownerThreadId,
          );
      }
      const contributionRows = this.db
        .prepare(
          `
          SELECT
            apply_id,
            commit_hash,
            apply_result_json,
            conversation_id,
            files_json,
            owner_thread_id,
            change_set_id,
            completion_event_id,
            assistant_message_event_id
          FROM self_mod_pending_contributions
          WHERE change_set_id = ? AND repo_root = ?
          ORDER BY sequence ASC
        `,
        )
        .all(changeSetId, this.repoRoot) as unknown as ContributionRow[];
      const contributionCommitHashes = contributionRows.map(
        (row) => row.commit_hash?.trim() ?? "",
      );
      const hasCompleteCommitSet =
        contributionCommitHashes.length > 0 &&
        contributionCommitHashes.every(Boolean) &&
        new Set(contributionCommitHashes).size === contributionRows.length;
      if (!existing?.commit_hashes_json && hasCompleteCommitSet) {
        this.db
          .prepare(
            `
            UPDATE self_mod_pending_change_sets
            SET commit_hashes_json = ?, updated_at = ?
            WHERE change_set_id = ? AND repo_root = ?
          `,
          )
          .run(
            JSON.stringify(contributionCommitHashes),
            Date.now(),
            changeSetId,
            this.repoRoot,
          );
      }
      const changeSetRow = this.db
        .prepare(
          `
          SELECT
            change_set_id,
            conversation_id,
            owner_thread_id,
            completion_event_id,
            assistant_message_event_id,
            commit_hashes_json,
            status
          FROM self_mod_pending_change_sets
          WHERE change_set_id = ? AND repo_root = ?
        `,
        )
        .get(changeSetId, this.repoRoot) as ChangeSetRow;
      return {
        changeSet: toChangeSet(changeSetRow),
        contributions: contributionRows.map(toContribution),
      };
    });
  }

  getChangeSet(changeSetIdInput: string): PersistedSelfModChangeSet | null {
    const changeSetId = changeSetIdInput.trim();
    if (!changeSetId) return null;
    const row = this.db
      .prepare(
        `
        SELECT
          change_set_id,
          conversation_id,
          owner_thread_id,
          completion_event_id,
          assistant_message_event_id,
          commit_hashes_json,
          status
        FROM self_mod_pending_change_sets
        WHERE change_set_id = ? AND repo_root = ?
        LIMIT 1
      `,
      )
      .get(changeSetId, this.repoRoot) as ChangeSetRow | undefined;
    return row ? toChangeSet(row) : null;
  }

  markAttached(args: {
    completionEventId: string;
    assistantMessageEventId: string;
  }): void {
    this.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          `
          UPDATE self_mod_pending_change_sets
          SET
            assistant_message_event_id = ?,
            status = CASE WHEN status = 'applied' THEN status ELSE 'attached' END,
            updated_at = ?
          WHERE repo_root = ? AND completion_event_id = ?
        `,
        )
        .run(
          args.assistantMessageEventId,
          now,
          this.repoRoot,
          args.completionEventId,
        );
      this.db
        .prepare(
          `
          UPDATE self_mod_pending_contributions
          SET assistant_message_event_id = ?, updated_at = ?
          WHERE repo_root = ? AND completion_event_id = ?
        `,
        )
        .run(
          args.assistantMessageEventId,
          now,
          this.repoRoot,
          args.completionEventId,
        );
    });
  }

  beginApply(args: { applyId?: string; commitHash?: string }): {
    changeSet: PersistedSelfModChangeSet;
    contributions: PersistedPendingSelfModApply[];
  } | null {
    return this.transaction(() => {
      const changeSetRow = this.db
        .prepare(
          `
          SELECT DISTINCT
            change_set.change_set_id,
            change_set.conversation_id,
            change_set.owner_thread_id,
            change_set.completion_event_id,
            change_set.assistant_message_event_id,
            change_set.commit_hashes_json,
            change_set.status
          FROM self_mod_pending_change_sets AS change_set
          LEFT JOIN self_mod_pending_contributions AS contribution
            ON contribution.change_set_id = change_set.change_set_id
          WHERE change_set.repo_root = ? AND (
            (? IS NOT NULL AND change_set.change_set_id = ?)
            OR (? IS NOT NULL AND contribution.commit_hash = ?)
          )
          LIMIT 1
        `,
        )
        .get(
          this.repoRoot,
          args.applyId ?? null,
          args.applyId ?? null,
          args.commitHash ?? null,
          args.commitHash ?? null,
        ) as ChangeSetRow | undefined;
      if (
        !changeSetRow ||
        changeSetRow.status === "applied" ||
        changeSetRow.status === "applying"
      ) {
        return null;
      }
      const contributionRows = this.db
        .prepare(
          `
          SELECT
            apply_id,
            commit_hash,
            apply_result_json,
            conversation_id,
            files_json,
            owner_thread_id,
            change_set_id,
            completion_event_id,
            assistant_message_event_id
          FROM self_mod_pending_contributions
          WHERE change_set_id = ? AND repo_root = ?
          ORDER BY sequence ASC
        `,
        )
        .all(
          changeSetRow.change_set_id,
          this.repoRoot,
        ) as unknown as ContributionRow[];
      if (contributionRows.length === 0) return null;
      this.db
        .prepare(
          `
          UPDATE self_mod_pending_change_sets
          SET status = 'applying', updated_at = ?
          WHERE change_set_id = ? AND repo_root = ?
        `,
        )
        .run(Date.now(), changeSetRow.change_set_id, this.repoRoot);
      return {
        changeSet: { ...toChangeSet(changeSetRow), status: "applying" },
        contributions: contributionRows.map(toContribution),
      };
    });
  }

  failApply(changeSetId: string): void {
    this.db
      .prepare(
        `
        UPDATE self_mod_pending_change_sets
        SET
          status = CASE
            WHEN assistant_message_event_id IS NULL THEN 'published'
            ELSE 'attached'
          END,
          updated_at = ?
        WHERE change_set_id = ? AND repo_root = ? AND status = 'applying'
      `,
      )
      .run(Date.now(), changeSetId, this.repoRoot);
  }

  completeApply(changeSetId: string): void {
    this.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          `DELETE FROM self_mod_pending_contributions WHERE change_set_id = ? AND repo_root = ?`,
        )
        .run(changeSetId, this.repoRoot);
      this.db
        .prepare(
          `
          UPDATE self_mod_pending_change_sets
          SET status = 'applied', updated_at = ?
          WHERE change_set_id = ? AND repo_root = ?
        `,
        )
        .run(now, changeSetId, this.repoRoot);
    });
  }
}
