/**
 * Walks an `EventRecord[]` for a conversation and returns the unique files
 * the assistant touched (modified, created, produced), most-recent first.
 *
 * Used by both the inline chat home overview's Recent files list AND the
 * "See all" dialog's paginated full file history (which feeds in extra
 * events from `useConversationHistoryPager`). Keeping the derivation in
 * one place means the dialog's paged view stays byte-identical to the
 * inline view for the same input window.
 */

import type { EventRecord } from "@/app/chat/lib/event-transforms";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
} from "../../../../runtime/contracts/file-changes.js";
import {
  isDisplayTabPayload,
  type DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import { buildPayloadFromBarePath } from "@/app/chat/lib/derive-turn-resource";

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
      | { fileChanges?: unknown; producedFiles?: unknown }
      | undefined;
    if (!payload || typeof payload !== "object") continue;

    const fileChanges = isFileChangeRecordArray(payload.fileChanges)
      ? payload.fileChanges
      : [];
    const produced = isProducedFileRecordArray(payload.producedFiles)
      ? payload.producedFiles
      : [];

    for (const record of [...fileChanges, ...produced]) {
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
