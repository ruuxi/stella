import type { Id } from "../_generated/dataModel";
import { AGENT_IDS, BASE_BACKEND_TOOL_NAMES } from "../lib/agent_constants";

export type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  ownerId?: string;
  conversationId?: Id<"conversations">;
  userMessageId?: Id<"events">;
  transient?: boolean;
};

/**
 * Reference list of all tool names across all tiers.
 * Not used for logic — only for documentation and type hints.
 */
export const BASE_TOOL_NAMES = [...BASE_BACKEND_TOOL_NAMES] as const;

export const DEFAULT_BACKEND_AGENT_TYPE = AGENT_IDS.GENERAL;
