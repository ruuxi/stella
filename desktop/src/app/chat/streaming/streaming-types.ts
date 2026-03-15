import type {
  AgentIdLike,
  AgentStreamEventType,
} from "@/shared/contracts/agent-runtime";

/**
 * Shared types for the streaming engine.
 * Separate file to avoid circular imports between
 * use-streaming-chat.ts and use-resume-agent-run.ts.
 */

export type SelfModAppliedData = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

export type AgentStreamEvent = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: SelfModAppliedData;
  taskId?: string;
  agentType?: AgentIdLike;
  description?: string;
  parentTaskId?: string;
  result?: string;
  statusText?: string;
};
