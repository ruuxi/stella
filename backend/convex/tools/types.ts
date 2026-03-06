import type { Id } from "../_generated/dataModel";

export type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  currentTaskId?: Id<"tasks">;
  ownerId?: string;
  conversationId?: Id<"conversations">;
  userMessageId?: Id<"events">;
  transient?: boolean;
};

/**
 * Reference list of all tool names across all tiers.
 * Not used for logic — only for documentation and type hints.
 */
export const BASE_TOOL_NAMES = [
  // Backend tools (server-side, used by offline fallback orchestrator)
  "WebSearch",
  "WebFetch",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
  "NoResponse",
] as const;
