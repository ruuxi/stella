import type { Id } from "../_generated/dataModel";

export type PluginToolDescriptor = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  currentTaskId?: Id<"tasks">;
  pluginTools: PluginToolDescriptor[];
  ownerId?: string;
  conversationId?: Id<"conversations">;
};

/**
 * Reference list of all tool names across all tiers.
 * Not used for logic — only for documentation and type hints.
 */
export const BASE_TOOL_NAMES = [
  // Device tools (Electron local execution)
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "AskUserQuestion",
  "RequestCredential",
  "SkillBash",
  "MediaGenerate",
  "SelfModStart",
  "SelfModApply",
  "SelfModRevert",
  "SelfModStatus",
  "SelfModPackage",
  "InstallSkillPackage",
  "InstallThemePackage",
  "InstallCanvasPackage",
  "InstallPluginPackage",
  "UninstallPackage",
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
  "OpenCanvas",
  "CloseCanvas",
  "StoreSearch",
  "GenerateApiSkill",
  "SelfModInstallBlueprint",
  "SpawnRemoteMachine",
  "NoResponse",
  // Orchestration tools
  "TaskCreate",
  "TaskOutput",
  "TaskCancel",
  "RecallMemories",
  "SaveMemory",
] as const;
