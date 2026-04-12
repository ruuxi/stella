/**
 * Shared type definitions for the tools system.
 */

import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
} from "../shared/scheduling.js";

export type ToolContext = {
  conversationId: string;
  deviceId: string;
  requestId: string;
  runId?: string;
  rootRunId?: string;
  agentType?: string;
  frontendRoot?: string;
  storageMode?: "cloud" | "local";
  taskId?: string;
  cloudTaskId?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
};

export type ToolResult = {
  result?: unknown;
  details?: unknown;
  error?: string;
};

export type ToolUpdateCallback = (update: ToolResult) => void;

export type ToolHandlerExtras = {
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
};

export type ToolMetadata = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ShellRecord = {
  id: string;
  command: string;
  cwd: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  completedAt: number | null;
  kill: () => void;
};

export type TaskRecord = {
  id: string;
  description: string;
  status: "running" | "completed" | "error";
  result?: string;
  error?: string;
  startedAt: number;
  completedAt: number | null;
};

export type TaskToolRequest = {
  conversationId: string;
  description: string;
  prompt: string;
  agentType: string;
  rootRunId?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  parentTaskId?: string;
  threadId?: string;
  toolsAllowlistOverride?: string[];
  storageMode: "cloud" | "local";
  selfModMetadata?: {
    featureId?: string;
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update";
    displayName?: string;
    description?: string;
  };
};

export type TaskToolSnapshot = {
  id: string;
  status: "running" | "completed" | "error" | "canceled";
  description: string;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  recentActivity?: string[];
  messages?: Array<{ from: "orchestrator" | "subagent"; text: string; timestamp: number }>;
};

export type TaskToolApi = {
  createTask: (request: TaskToolRequest) => Promise<{ threadId: string }>;
  getTask: (threadId: string) => Promise<TaskToolSnapshot | null>;
  cancelTask: (threadId: string, reason?: string) => Promise<{ canceled: boolean }>;
  sendTaskMessage?: (
    threadId: string,
    message: string,
    from: "orchestrator" | "subagent",
  ) => Promise<{ delivered: boolean }>;
  drainTaskMessages?: (
    threadId: string,
    recipient: "orchestrator" | "subagent",
  ) => Promise<string[]>;
};

export type ToolHostOptions = {
  stellaHomePath: string;
  frontendRoot?: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  taskApi?: TaskToolApi;
  scheduleApi?: ScheduleToolApi;
  extensionTools?: import("../extensions/types.js").ToolDefinition[];
  displayHtml?: (html: string) => void;
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
};

export type ScheduleToolApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  addCronJob: (input: LocalCronJobCreateInput) => Promise<LocalCronJobRecord>;
  updateCronJob: (
    jobId: string,
    patch: LocalCronJobUpdatePatch,
  ) => Promise<LocalCronJobRecord | null>;
  removeCronJob: (jobId: string) => Promise<boolean>;
  runCronJob: (jobId: string) => Promise<LocalCronJobRecord | null>;
  getHeartbeatConfig: (
    conversationId: string,
  ) => Promise<LocalHeartbeatConfigRecord | null>;
  upsertHeartbeat: (
    input: LocalHeartbeatUpsertInput,
  ) => Promise<LocalHeartbeatConfigRecord>;
  runHeartbeat: (
    conversationId: string,
  ) => Promise<LocalHeartbeatConfigRecord | null>;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
  extras?: ToolHandlerExtras,
) => Promise<ToolResult>;
