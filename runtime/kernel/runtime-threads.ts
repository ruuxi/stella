/**
 * Active work is budgeted in SLOTS, not raw threads: a thread group
 * (several related threads spawned for one request) occupies one slot,
 * and an ungrouped thread is its own slot. Eviction flips whole slots
 * to 'evicted'; the rows survive and stay resumable via `send_input`
 * and discoverable via `Recall`.
 */
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
  status: "active" | "evicted";
  createdAt: number;
  lastUsedAt: number;
  description?: string;
  summary?: string;
  groupKey?: string;
  groupLabel?: string;
};

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

export const formatRuntimeThreadAge = (timestamp: number, now = Date.now()): string => {
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

const formatPromptValue = (value: string | undefined, fallback: string): string => {
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
    `${indent}- ${thread.threadId} (resumable, last used ${formatRuntimeThreadAge(thread.lastUsedAt, now)})`,
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
  lastUsedAt: number;
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
    const slot = slots.get(slotKey);
    if (slot) {
      slot.threads.push(thread);
      slot.lastUsedAt = Math.max(slot.lastUsedAt, thread.lastUsedAt);
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
        lastUsedAt: thread.lastUsedAt,
        threads: [thread],
      });
    }
  }
  const ordered = [...slots.values()];
  ordered.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const slot of ordered) {
    slot.threads.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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
    const header = `## ${label} [${slot.groupKey}] (last used ${formatRuntimeThreadAge(slot.lastUsedAt, now)})`;
    const lines = slot.threads.map((thread) =>
      formatThreadLines(thread, now, "  "),
    );
    return [header, ...lines].join("\n");
  });
  return `# Other Threads\nDurable past and ongoing work, grouped when several threads serve one request. Any thread_id can be reused later with send_input, even after cancellation or completion. A group id (grp-…) works with pause_agent to stop the whole group, and with spawn_agent's \`group\` to add related work. Older work not listed here is searchable with Recall.\n${blocks.join("\n")}`;
};
