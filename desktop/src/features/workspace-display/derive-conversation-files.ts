/**
 * Walks an `EventRecord[]` for a conversation and returns the unique files
 * the assistant touched (modified, created, produced), most-recent first.
 *
 * Used by both the inline chat home overview's Recent files list AND the
 * "See all" dialog's paginated full file history (both fed by
 * `useConversationFiles` / `conversation.files`). Keeping the derivation
 * in one place means the dialog's paged view stays byte-identical to the
 * inline view for the same input window.
 */

import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  MAX_PRODUCED_FILES_PER_COMMAND,
  type FileChangeRecord,
} from "../../../../runtime/contracts/file-changes.js";
import {
  isDisplayTabPayload,
  type DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import { buildPayloadFromBarePath } from "@/features/chat/lib/derive-turn-resource";
import { isNoiseProducedPath } from "@/features/workspace-display/path-to-viewer";

export type ConversationFileEntry = {
  path: string;
  timestamp: number;
  payload: DisplayTabPayload;
};

const resolvedPathForChange = (record: FileChangeRecord): string | null => {
  if (record.kind.type === "delete") return null;
  const path =
    record.kind.type === "update" && record.kind.move_path
      ? record.kind.move_path
      : record.path;
  if (!path || !path.startsWith("/")) return null;
  return path;
};

export function deriveConversationFiles(
  events: ReadonlyArray<EventRecord>,
  options?: { cap?: number },
): ConversationFileEntry[] {
  const seen = new Map<string, ConversationFileEntry>();

  for (const event of events) {
    const payload = event.payload as
      | {
          toolName?: unknown;
          error?: unknown;
          filePath?: unknown;
          slug?: unknown;
          title?: unknown;
          createdAt?: unknown;
          fileChanges?: unknown;
          producedFiles?: unknown;
        }
      | undefined;
    if (!payload || typeof payload !== "object") continue;

    if (
      payload.toolName === "html" &&
      !payload.error &&
      typeof payload.filePath === "string" &&
      payload.filePath.startsWith("/")
    ) {
      seen.set(payload.filePath, {
        path: payload.filePath,
        timestamp: event.timestamp,
        payload: {
          kind: "canvas-html",
          filePath: payload.filePath,
          ...(typeof payload.title === "string" ? { title: payload.title } : {}),
          ...(typeof payload.slug === "string" ? { slug: payload.slug } : {}),
          createdAt:
            typeof payload.createdAt === "number" &&
            Number.isFinite(payload.createdAt)
              ? payload.createdAt
              : event.timestamp,
        },
      });
      continue;
    }

    const fileChanges = isFileChangeRecordArray(payload.fileChanges)
      ? payload.fileChanges
      : [];
    // Snapshot-detected produced files sweep up profile/cache/log noise
    // (e.g. `.brave-profile/Local State`, `.stella-launch.log`) alongside
    // real deliverables — drop the noise here so completion-card pills and
    // the Recent files list only show user-facing outputs. Explicit
    // `fileChanges` are deliberate tool edits and stay unfiltered.
    //
    // The shell collector now applies the same filter (plus a bulk-churn
    // cap) at collection time; this pass remains for rows persisted before
    // that existed. The per-command bulk guard is mirrored here for legacy
    // `tool_result` rows only: a single command that "produced" dozens of
    // files was environment churn (spawned dev-instance bootstrap seeding,
    // git checkout mtime rewrites), not deliverables. `agent-completed`
    // rollups aggregate many commands and may legitimately exceed the
    // per-command cap, so they're exempt.
    const producedDenoised = (
      isProducedFileRecordArray(payload.producedFiles)
        ? payload.producedFiles
        : []
    ).filter((record) => {
      const path = resolvedPathForChange(record);
      return path === null || !isNoiseProducedPath(path);
    });
    const produced =
      event.type === "tool_result" &&
      producedDenoised.length > MAX_PRODUCED_FILES_PER_COMMAND
        ? []
        : producedDenoised;

    for (const record of [...fileChanges, ...produced]) {
      // A delete retires the entry, and a move retires the source path —
      // otherwise a file the agent removed or renamed lingers in the list
      // forever because `resolvedPathForChange` only ever adds.
      if (record.kind.type === "delete") {
        seen.delete(record.path);
        continue;
      }
      if (record.kind.type === "update" && record.kind.move_path) {
        seen.delete(record.path);
      }
      const path = resolvedPathForChange(record);
      if (!path) continue;
      const filePayload = buildPayloadFromBarePath(path, event.timestamp, {
        produced: true,
      });
      if (!filePayload || !isDisplayTabPayload(filePayload)) continue;
      // Most-recent occurrence wins so the timestamp reflects the
      // latest activity for that file.
      seen.set(path, {
        path,
        timestamp: event.timestamp,
        payload: filePayload,
      });
    }
  }

  const all = Array.from(seen.values()).sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  if (options?.cap !== undefined) {
    return all.slice(0, options.cap);
  }
  return all;
}
