/**
 * Per-agent file attribution for the left-sidebar Activity tray.
 *
 * Each agent's lifecycle events — notably `agent-completed`, which carries the
 * run's `fileChanges` / `producedFiles` — are replayed through the shared
 * `deriveConversationFiles` derivation, so the per-agent list dedupes by path
 * exactly like the old standalone Files section did.
 *
 * Kept as a pure module (no React) so the memoization signature is
 * unit-testable, mirroring the other extracted chat derivations.
 */
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";

/** Group the files an agent produced under its own id. */
export function deriveAgentFilesMap(
  activities: ReadonlyArray<EventRecord>,
): Map<string, ConversationFileEntry[]> {
  const eventsByAgent = new Map<string, EventRecord[]>();
  for (const event of activities) {
    const agentId = (event.payload as { agentId?: unknown } | undefined)
      ?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    const list = eventsByAgent.get(agentId);
    if (list) list.push(event);
    else eventsByAgent.set(agentId, [event]);
  }
  const filesByAgent = new Map<string, ConversationFileEntry[]>();
  for (const [agentId, events] of eventsByAgent) {
    const files = deriveConversationFiles(events);
    if (files.length > 0) filesByAgent.set(agentId, files);
  }
  return filesByAgent;
}

/**
 * Whether an event could contribute a file entry to an agent's files (the
 * only inputs `deriveAgentFilesMap` -> `deriveConversationFiles` turns into
 * output): a produced html canvas, or a non-empty `fileChanges` /
 * `producedFiles` list. Deliberately a *superset* of what actually resolves
 * to a path — being over-inclusive only costs an occasional redundant
 * recompute, whereas missing one would return stale files.
 */
export function eventContributesFiles(event: EventRecord): boolean {
  const payload = event.payload as
    | {
        toolName?: unknown;
        error?: unknown;
        filePath?: unknown;
        fileChanges?: unknown;
        producedFiles?: unknown;
      }
    | undefined;
  if (!payload || typeof payload !== "object") return false;
  if (
    payload.toolName === "html" &&
    !payload.error &&
    typeof payload.filePath === "string" &&
    payload.filePath.startsWith("/")
  ) {
    return true;
  }
  if (Array.isArray(payload.fileChanges) && payload.fileChanges.length > 0) {
    return true;
  }
  if (Array.isArray(payload.producedFiles) && payload.producedFiles.length > 0) {
    return true;
  }
  return false;
}

/**
 * Cheap content signature of everything `deriveAgentFilesMap` depends on: the
 * ordered set of file-contributing events that carry an `agentId`, keyed by
 * `agentId`, event `_id`, `timestamp`, and file-record count.
 *
 * The activity window is refetched (new array identity) on every streamed
 * delta even though file events are rare, so memoizing the map on the array
 * reference recomputes the whole per-agent file map every token. Memoizing on
 * THIS signature instead means the heavy `deriveConversationFiles` walk only
 * re-runs when an agent's files actually change — during pure text streaming
 * the signature is unchanged and the prior map is reused. Building the
 * signature is O(activities) cheap (a few property reads per event) vs. the
 * O(activities) heavy per-agent payload/path derivation it guards.
 */
export function agentFilesSignature(
  activities: ReadonlyArray<EventRecord>,
): string {
  let signature = "";
  for (const event of activities) {
    const agentId = (event.payload as { agentId?: unknown } | undefined)
      ?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    if (!eventContributesFiles(event)) continue;
    const payload = event.payload as {
      fileChanges?: unknown;
      producedFiles?: unknown;
    };
    const fileCount =
      (Array.isArray(payload.fileChanges) ? payload.fileChanges.length : 0) +
      (Array.isArray(payload.producedFiles) ? payload.producedFiles.length : 0);
    signature += `${agentId}\u001f${event._id}\u001f${event.timestamp}\u001f${fileCount}\u001e`;
  }
  return signature;
}
