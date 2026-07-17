import type {
  AgentIdLike,
  AgentRunFinishOutcome,
  AgentStreamEventType,
  TaskToolActivity,
} from "./agent-runtime.js";

export type SelfModAppliedData = {
  featureId: string;
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied";
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
  /** Runtime-recorder sequence retained when the main process re-sequences IPC. */
  sourceSeq?: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  rootRunId?: string;
  chunk?: string;
  statusState?: "running" | "compacting" | "provider-retry" | "model-fallback";
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
  attemptGeneration?: number;
  toolActivity?: TaskToolActivity;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?: AgentResponseTarget;
  /** Canonical SQLite row persisted for an `ASSISTANT_MESSAGE` boundary. */
  assistantMessageEventId?: string;
  /** Canonical text for the finalized message; provider deltas are optimistic. */
  assistantMessageText?: string;
  /**
   * On an `ASSISTANT_MESSAGE` boundary: true when the message that just
   * finalized ends with a tool call, i.e. it is an interim/preamble message
   * rather than the run's final answer. The renderer keeps the working
   * indicator up (instead of handing off to the painted preamble text)
   * across the gap between this message and the tool it precedes.
   */
  followedByToolCall?: boolean;
  /**
   * Work group of the agent thread this event belongs to (`grp-…` key
   * plus its human label). Present on agent lifecycle events whose
   * thread was spawned into a group; the Activity UI collapses rows
   * sharing a groupKey under one header.
   */
  groupKey?: string;
  groupLabel?: string;
};
