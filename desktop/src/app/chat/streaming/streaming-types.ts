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

export type AgentResponseTarget =
  | { type: "user_turn" }
  | { type: "agent_turn"; agentId: string }
  | {
      type: "agent_terminal_notice";
      agentId: string;
      terminalState: "completed" | "failed" | "canceled";
    };

export type AgentStreamEvent = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  rootRunId?: string;
  chunk?: string;
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
  agentId?: string;
  agentType?: AgentIdLike;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?: AgentResponseTarget;
};
