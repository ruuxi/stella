import type { Id } from "../_generated/dataModel";

export type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  currentTaskId?: Id<"tasks">;
  ownerId?: string;
  conversationId?: Id<"conversations">;
  userMessageId?: Id<"events">;
  targetDeviceId?: string;
  transient?: boolean;
};

/**
 * Reference list of all tool names across all tiers.
 * Not used for logic — only for documentation and type hints.
 */
export const BASE_TOOL_NAMES = [
  // Device tools (Electron local execution)
  "Read",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "AskUserQuestion",
  "RequestCredential",
  "SkillBash",
  "MediaGenerate",
  // Backend tools (always available, server-side)
  "WebSearch",
  "WebFetch",
  "IntegrationRequest",
  "ActivateSkill",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
  "GenerateApiSkill",
  "ListResources",
  "NoResponse",
  // Orchestration tools
  "TaskCreate",
  "TaskOutput",
  "TaskCancel",
  "RecallMemories",
  "SaveMemory",
] as const;
