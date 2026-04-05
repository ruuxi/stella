export const MAX_ACTIVE_RUNTIME_THREADS = 16;
export const RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS = 25_000;

export type RuntimeThreadRecord = {
  conversationId: string;
  threadId: string;
  agentType: string;
  status: "active" | "evicted";
  createdAt: number;
  lastUsedAt: number;
  summary?: string;
};

export const normalizeRuntimeThreadId = (value: string): string | undefined => {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const estimateRuntimeTokens = (value: string): number => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0;
};

const formatAge = (timestamp: number, now: number): string => {
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

export const buildActiveThreadsPrompt = (
  threads: RuntimeThreadRecord[],
  now = Date.now(),
): string => {
  if (threads.length === 0) return "";
  const lines = threads.slice(0, MAX_ACTIVE_RUNTIME_THREADS).map((thread) => {
    const summary = thread.summary?.trim()
      ? ` - ${thread.summary.trim().replace(/\s+/g, " ").slice(0, 180)}`
      : "";
    return `- ${thread.threadId} (${thread.agentType}, last used ${formatAge(thread.lastUsedAt, now)})${summary}`;
  });
  return `# Active Threads\nEach thread_id is durable and can be reused later for continued work, even after cancellation or completion, and even if it falls out of the active list.\n${lines.join("\n")}`;
};
