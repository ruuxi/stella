import type {
  AgentIdLike,
  AgentRunFinishOutcome,
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
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  rootRunId?: string;
  chunk?: string;
  kind?: "text" | "reasoning";
  statusState?: "running" | "compacting";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  details?: unknown;
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
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
};
