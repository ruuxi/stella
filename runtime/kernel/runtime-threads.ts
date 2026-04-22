export const MAX_ACTIVE_RUNTIME_THREADS = 16;

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

export const buildActiveThreadsPrompt = (
  threads: RuntimeThreadRecord[],
  now = Date.now(),
): string => {
  if (threads.length === 0) return "";
  const lines = threads.slice(0, MAX_ACTIVE_RUNTIME_THREADS).map((thread) => {
    const summary = formatPromptValue(thread.summary, "");
    return [
      `- ${thread.threadId} (resumable, last used ${formatRuntimeThreadAge(thread.lastUsedAt, now)})`,
      `  description: ${formatPromptValue(thread.description, "No description recorded")}`,
      ...(summary ? [`  summary: ${summary}`] : []),
    ].join("\n");
  });
  return `# Other Threads\nThese thread_ids are durable and can be reused later for continued work, even after cancellation or completion.\n${lines.join("\n")}`;
};
