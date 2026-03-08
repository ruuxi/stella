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
  type: "stream" | "tool-start" | "tool-end" | "error" | "end" | "task-started" | "task-completed" | "task-failed" | "task-progress";
  runId: string;
  seq: number;
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: SelfModAppliedData;
  taskId?: string;
  agentType?: string;
  description?: string;
  parentTaskId?: string;
  result?: string;
  statusText?: string;
};
