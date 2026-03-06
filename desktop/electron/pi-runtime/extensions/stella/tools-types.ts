/**
 * Shared type definitions for the tools system.
 */

import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
} from "../../../scheduling/types.js";

export type ToolContext = {
  conversationId: string;
  deviceId: string;
  requestId: string;
  agentType?: string;
  storageMode?: "cloud" | "local";
  taskId?: string;
};

export type ToolResult = {
  result?: unknown;
  error?: string;
};

export type SecretMountSpec = {
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
};

export type SecretMounts = {
  env?: Record<string, SecretMountSpec>;
  files?: Record<string, SecretMountSpec>;
};

export type ResolvedSecret = {
  secretId: string;
  provider: string;
  label: string;
  plaintext: string;
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
  parentTaskId?: string;
  threadId?: string;
  threadName?: string;
  commandId?: string;
  systemPromptOverride?: string;
  storageMode: "cloud" | "local";
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
  createTask: (request: TaskToolRequest) => Promise<{ taskId: string }>;
  getTask: (taskId: string) => Promise<TaskToolSnapshot | null>;
  cancelTask: (taskId: string, reason?: string) => Promise<{ canceled: boolean }>;
  sendTaskMessage?: (
    taskId: string,
    message: string,
    from: "orchestrator" | "subagent",
  ) => Promise<{ delivered: boolean }>;
  drainTaskMessages?: (
    taskId: string,
    recipient: "orchestrator" | "subagent",
  ) => Promise<string[]>;
};

export type ToolHostOptions = {
  StellaHome: string;
  frontendRoot?: string;
  taskApi?: TaskToolApi;
  scheduleApi?: ScheduleToolApi;
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  resolveSecret?: (payload: {
    provider: string;
    secretId?: string;
    requestId?: string;
    toolName?: string;
    deviceId?: string;
  }) => Promise<ResolvedSecret | null>;
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  markdown: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  tags?: string[];
  execution?: "backend" | "device";
  requiresSecrets?: string[];
  publicIntegration?: boolean;
  secretMounts?: SecretMounts;
  version: number;
  source: string;
  filePath: string;
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
) => Promise<ToolResult>;
