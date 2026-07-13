/**
 * Active work is budgeted in SLOTS, not raw threads: a thread group
 * (several related threads spawned for one request) occupies one slot,
 * and an ungrouped thread is its own slot. Eviction flips whole slots
 * to 'evicted'; the rows survive and stay resumable via `send_input`
 * and discoverable via `Recall`.
 */
import type { TaskLifecycleStatus } from "../contracts/agent-runtime.js";

export const MAX_ACTIVE_RUNTIME_THREADS = 16;

/**
 * Cap on active member threads per group so one fan-out can't grow the
 * injected context block without bound. The 9th spawn into a group is
 * rejected with an instructive error (continue a member with
 * `send_input` instead).
 */
export const MAX_GROUP_MEMBER_THREADS = 8;

/**
 * Group keys are minted as `grp-<slug>` so the orchestrator (and the
 * pause routing) can tell a group id from a thread id at a glance.
 */
export const THREAD_GROUP_KEY_PREFIX = "grp-";

export type RuntimeThreadRecord = {
  conversationId: string;
  threadId: string;
  name: string;
  agentType: string;
  // Slot/eviction state, NOT execution state: "active" means the thread
  // still occupies a live roster slot (vs "evicted" — dropped from the
  // budget but resumable). This says nothing about whether the agent is
  // currently running a turn; that is `agentStatus`.
  status: "active" | "evicted";
  createdAt: number;
  lastUsedAt: number;
  // Live lifecycle status of the agent bound to this thread, sourced from
  // `runtime_agents.status`. "running" means the agent is executing a turn
  // right now; any terminal value (or absence) means it is idle/resumable.
  // This is the single source of truth for the active-vs-paused distinction
  // surfaced to the orchestrator.
  agentStatus?: TaskLifecycleStatus;
  // When the agent record was last written (turn start / terminal). Folded
  // into the last-active timestamp so a currently-running thread reads as
  // freshly active even if the durable thread row wasn't touched this turn.
  agentUpdatedAt?: number;
  description?: string;
  summary?: string;
  groupKey?: string;
  groupLabel?: string;
};

/**
 * The one place the orchestrator-facing active-vs-paused distinction is
 * derived. Per the product model there is no "dead" thread: a thread is
 * either actively executing a turn or paused (idle but resumable). Only a
 * live "running" agent record counts as active; everything else — a
 * terminal run outcome or no agent record at all — is paused.
 */
export type RuntimeThreadLiveState = "active" | "paused";

export const deriveRuntimeThreadLiveState = (
  record: Pick<RuntimeThreadRecord, "agentStatus">,
): RuntimeThreadLiveState =>
  record.agentStatus === "running" ? "active" : "paused";

/**
 * Genuine last-activity time: the newer of the durable thread row's
 * `lastUsedAt` and the agent record's `updatedAt`. A running turn bumps the
 * agent record even when the thread row wasn't re-touched, so this keeps the
 * recency the orchestrator reasons about honest.
 */
export const runtimeThreadLastActiveAt = (
  record: Pick<RuntimeThreadRecord, "lastUsedAt" | "agentUpdatedAt">,
): number => Math.max(record.lastUsedAt, record.agentUpdatedAt ?? 0);

/**
 * Compact, machine-legible status token for a single thread. Primary token
 * is always active/paused; a paused thread whose last run errored keeps that
 * detail (still resumable, but worth flagging) so the orchestrator isn't
 * flying blind on failures.
 */
export const formatRuntimeThreadStatusLabel = (
  record: Pick<RuntimeThreadRecord, "agentStatus">,
): string => {
  if (deriveRuntimeThreadLiveState(record) === "active") return "active";
  return record.agentStatus === "error"
    ? "paused (last run errored)"
    : "paused";
};

/**
 * The shared `(<status>, last active <age>)` suffix used verbatim by both the
 * injected "# Other Threads" roster and Recall's thread search, so both
 * surfaces read the same live state from the same signal.
 */
export const formatRuntimeThreadStatusSuffix = (
  record: Pick<
    RuntimeThreadRecord,
    "agentStatus" | "lastUsedAt" | "agentUpdatedAt"
  >,
  now = Date.now(),
): string =>
  `${formatRuntimeThreadStatusLabel(record)}, last active ${formatRuntimeThreadAge(
    runtimeThreadLastActiveAt(record),
    now,
  )}`;

export const normalizeRuntimeThreadId = (value: string): string | undefined => {
  // Preserve case: conversation ids are case-sensitive and orchestrator thread
  // keys are derived directly from them.
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const estimateRuntimeTokens = (value: string): number => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0;
};

export const formatRuntimeThreadAge = (
  timestamp: number,
  now = Date.now(),
): string => {
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

const formatPromptValue = (
  value: string | undefined,
  fallback: string,
): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\s+/g, " ").slice(0, 180) : fallback;
};

const formatThreadLines = (
  thread: RuntimeThreadRecord,
  now: number,
  indent: string,
): string => {
  const summary = formatPromptValue(thread.summary, "");
  return [
    `${indent}- ${thread.threadId} (${formatRuntimeThreadStatusSuffix(thread, now)})`,
    `${indent}  description: ${formatPromptValue(
      thread.description ??
        (thread.name !== thread.threadId ? thread.name : undefined),
      "No description recorded",
    )}`,
    ...(summary ? [`${indent}  summary: ${summary}`] : []),
  ].join("\n");
};

type WorkSlot = {
  groupKey?: string;
  groupLabel?: string;
  lastActiveAt: number;
  threads: RuntimeThreadRecord[];
};

/**
 * Group the active-thread list into work slots, ordered by slot recency.
 * Input ordering (per-thread recency) is not assumed.
 */
const collectWorkSlots = (threads: RuntimeThreadRecord[]): WorkSlot[] => {
  const slots = new Map<string, WorkSlot>();
  for (const thread of threads) {
    const slotKey = thread.groupKey ?? thread.threadId;
    const threadLastActive = runtimeThreadLastActiveAt(thread);
    const slot = slots.get(slotKey);
    if (slot) {
      slot.threads.push(thread);
      slot.lastActiveAt = Math.max(slot.lastActiveAt, threadLastActive);
      if (!slot.groupLabel && thread.groupLabel) {
        slot.groupLabel = thread.groupLabel;
      }
    } else {
      slots.set(slotKey, {
        ...(thread.groupKey
          ? {
              groupKey: thread.groupKey,
              ...(thread.groupLabel ? { groupLabel: thread.groupLabel } : {}),
            }
          : {}),
        lastActiveAt: threadLastActive,
        threads: [thread],
      });
    }
  }
  const ordered = [...slots.values()];
  ordered.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  for (const slot of ordered) {
    slot.threads.sort(
      (a, b) => runtimeThreadLastActiveAt(b) - runtimeThreadLastActiveAt(a),
    );
  }
  return ordered;
};

export const buildActiveThreadsPrompt = (
  threads: RuntimeThreadRecord[],
  now = Date.now(),
): string => {
  if (threads.length === 0) return "";
  const slots = collectWorkSlots(threads).slice(0, MAX_ACTIVE_RUNTIME_THREADS);
  const blocks = slots.map((slot) => {
    if (!slot.groupKey || slot.threads.length === 1) {
      // Ungrouped threads (and degenerate one-member groups) render exactly
      // like the historical flat entries — no header noise for the common case.
      const lines = slot.threads.map((thread) =>
        formatThreadLines(thread, now, ""),
      );
      return lines.join("\n");
    }
    const label = formatPromptValue(slot.groupLabel, slot.groupKey);
    // A group is "active" if any member is currently executing a turn.
    const groupState = slot.threads.some(
      (thread) => deriveRuntimeThreadLiveState(thread) === "active",
    )
      ? "active"
      : "paused";
    const header = `## ${label} [${slot.groupKey}] (${groupState}, last active ${formatRuntimeThreadAge(slot.lastActiveAt, now)})`;
    const lines = slot.threads.map((thread) =>
      formatThreadLines(thread, now, "  "),
    );
    return [header, ...lines].join("\n");
  });
  return `# Other Threads\nDurable past and ongoing work. Older stored work may still appear under historical group headings. Each entry shows its live state: "active" means the agent is executing a turn right now; "paused" means idle but resumable. Any thread_id can be reused later with send_input, even after cancellation or completion. A historical group id (grp-…) still works with pause_agent to stop the whole group. Older work not listed here is searchable with Recall.\n${blocks.join("\n")}`;
};
