export const DEFAULT_HEARTBEAT_PROMPT =
  "Read the heartbeat checklist if provided. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, call NoResponse().";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

export function resolveHeartbeatPrompt(params: {
  prompt?: string | null;
  checklist?: string | null;
}) {
  const base = typeof params.prompt === "string" ? params.prompt.trim() : "";
  const resolved = base || DEFAULT_HEARTBEAT_PROMPT;
  const checklist = typeof params.checklist === "string" ? params.checklist.trim() : "";
  if (!checklist) {
    return resolved;
  }
  return `${resolved}\n\nHeartbeat checklist:\n${checklist}`;
}

export function isHeartbeatContentEffectivelyEmpty(
  content: string | undefined | null,
): boolean {
  if (content === undefined || content === null) {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    return false;
  }
  return true;
}
