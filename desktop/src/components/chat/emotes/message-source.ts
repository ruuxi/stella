import type { MessagePayload } from "@/hooks/use-conversation-events";

const EXCLUDED_SOURCES = new Set(["heartbeat", "cron"]);

export const isOrchestratorChatMessagePayload = (
  payload: MessagePayload | null | undefined,
): boolean => {
  if (!payload || typeof payload !== "object") {
    // Legacy messages can be missing metadata; default to chat behavior.
    return true;
  }

  const agentType =
    typeof payload.agentType === "string"
      ? payload.agentType.trim().toLowerCase()
      : "";
  if (agentType && agentType !== "orchestrator") {
    return false;
  }

  const source =
    typeof payload.source === "string"
      ? payload.source.trim().toLowerCase()
      : "";
  if (!source) {
    return true;
  }
  if (EXCLUDED_SOURCES.has(source)) {
    return false;
  }
  if (source.startsWith("channel:")) {
    return false;
  }

  return true;
};
