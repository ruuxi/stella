import type { ToolContext } from "./types.js";

const MAX_SESSION_LENGTH = 120;

export const sanitizeStellaComputerSessionId = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SESSION_LENGTH);

  return sanitized || null;
};

export const getStellaComputerSessionId = (
  context?: ToolContext,
): string | null => {
  const ownerSegment = sanitizeStellaComputerSessionId(
    context?.agentId
      ? `task-${context.agentId}`
      : context?.runId
        ? `run-${context.runId}`
        : context?.rootRunId
          ? `root-${context.rootRunId}`
          : context?.requestId
            ? `request-${context.requestId}`
            : context?.conversationId
              ? `conversation-${context.conversationId}`
              : null,
  );
  if (!ownerSegment) {
    return null;
  }

  const agentSegment =
    sanitizeStellaComputerSessionId(context?.agentType) ?? "agent";
  return `${agentSegment}-${ownerSegment}`.slice(0, MAX_SESSION_LENGTH);
};
