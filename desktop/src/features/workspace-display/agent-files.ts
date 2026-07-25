/**
 * Per-agent file attribution for the Activity/Tasks surface.
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

/**
 * Group the files an agent produced under its own id.
 *
 * `eventFilter` optionally narrows which events participate (e.g. the chat
 * completion card passes `isAgentCompletedEvent` so only the rolled-up
 * completion records count); by default every agent-attributed event
 * contributes, matching the sidebar Activity tray.
 */
export function deriveAgentFilesMap(
  activities: ReadonlyArray<EventRecord>,
  eventFilter?: (event: EventRecord) => boolean,
): Map<string, ConversationFileEntry[]> {
  const eventsByAgent = new Map<string, EventRecord[]>();
  for (const event of activities) {
    if (eventFilter && !eventFilter(event)) continue;
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

const eventAgentId = (event: EventRecord): string | null => {
  const agentId = (event.payload as { agentId?: unknown } | undefined)
    ?.agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : null;
};

/**
 * Merge the activity window (agent lifecycle events, notably the
 * `agent-completed` file rollup) with the files window's agent-attributed
 * file events (`tool_result` rows stamped with `agentId` as tools finish) so
 * per-agent file lists update LIVE while the agent works instead of waiting
 * for completion.
 *
 * - Only agent-attributed, file-carrying file events are admitted — pure
 *   text/reasoning deltas never enter, so downstream signatures stay
 *   unchanged during streaming.
 * - Events present in both windows (`agent-completed` appears in each) are
 *   deduped by `_id`; a file reported live AND in the completion rollup
 *   collapses by path inside `deriveConversationFiles`, so nothing
 *   double-lists when the agent finishes.
 * - Both inputs arrive ASC by `(timestamp, _id)` (SQL ordering of
 *   `listActivity` / `listFiles`), and the output preserves that ordering so
 *   "most recent occurrence wins" path-dedup semantics hold.
 *
 * Returns the `activities` array untouched when the files window adds
 * nothing, keeping the reference stable for memoized consumers.
 */
export function mergeAgentFileEvents(
  activities: ReadonlyArray<EventRecord>,
  fileEvents: ReadonlyArray<EventRecord>,
): ReadonlyArray<EventRecord> {
  if (fileEvents.length === 0) return activities;
  const seenIds = new Set<string>();
  for (const event of activities) seenIds.add(event._id);
  const extras = fileEvents.filter(
    (event) =>
      !seenIds.has(event._id) &&
      eventAgentId(event) !== null &&
      eventContributesFiles(event),
  );
  if (extras.length === 0) return activities;
  const before = (a: EventRecord, b: EventRecord): boolean =>
    a.timestamp < b.timestamp ||
    (a.timestamp === b.timestamp && a._id <= b._id);
  const merged: EventRecord[] = [];
  let i = 0;
  let j = 0;
  while (i < activities.length && j < extras.length) {
    if (before(activities[i], extras[j])) merged.push(activities[i++]);
    else merged.push(extras[j++]);
  }
  while (i < activities.length) merged.push(activities[i++]);
  while (j < extras.length) merged.push(extras[j++]);
  return merged;
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
