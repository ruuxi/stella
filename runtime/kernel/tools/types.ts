/**
 * Shared type definitions for the tools system.
 */

import type { TaskLifecycleStatus } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../../../desktop/src/shared/contracts/file-changes.js";
import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
} from "../shared/scheduling.js";
import type { RuntimeThreadRecord } from "../runtime-threads.js";

export type ToolContext = {
  conversationId: string;
  deviceId: string;
  requestId: string;
  runId?: string;
  rootRunId?: string;
  agentType?: string;
  stellaRoot?: string;
  storageMode?: "cloud" | "local";
  agentId?: string;
  cloudAgentId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  allowedToolNames?: string[];
};

export type ToolResult = {
  result?: unknown;
  details?: unknown;
  error?: string;
  /**
   * Normalized record of any filesystem mutations the tool performed.
   *
   * Mirrors Codex's `fileChange` items: the runtime worker hoists this
   * field into the persisted `tool_result` event payload, and the chat
   * surface walks the records to build a per-turn `editedFilePaths`
   * list — without having to know which specific tool produced the
   * change.
   *
   * Tools that don't mutate the filesystem leave this `undefined`.
   * Shell-like tools should use `producedFiles` for snapshot-detected outputs
   * rather than treating arbitrary CLI side effects as explicit edits.
   */
  fileChanges?: FileChangeRecord[];
  /**
   * User-facing output files detected from a tool side effect. This is for
   * artifacts Stella should show to the user even when they were produced by
   * shell/CLI work rather than an explicit file-edit tool.
   */
  producedFiles?: ProducedFileRecord[];
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

export type AgentRecord = {
  id: string;
  description: string;
  status: "running" | "completed" | "error";
  result?: string;
  error?: string;
  startedAt: number;
  completedAt: number | null;
};

export type AgentToolRequest = {
  conversationId: string;
  description: string;
  prompt: string;
  agentType: string;
  rootRunId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  parentAgentId?: string;
  threadId?: string;
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

export type AgentToolSnapshot = {
  id: string;
  status: TaskLifecycleStatus;
  description: string;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  recentActivity?: string[];
  messages?: Array<{ from: "orchestrator" | "subagent"; text: string; timestamp: number }>;
};

export type AgentToolApi = {
  createAgent: (request: AgentToolRequest) => Promise<{
    threadId: string;
    activeThreads?: RuntimeThreadRecord[];
  }>;
  getAgent: (threadId: string) => Promise<AgentToolSnapshot | null>;
  cancelAgent: (threadId: string, reason?: string) => Promise<{ canceled: boolean }>;
  sendAgentMessage?: (
    threadId: string,
    message: string,
    from: "orchestrator" | "subagent",
    options?: { interrupt?: boolean },
  ) => Promise<{ delivered: boolean }>;
  drainAgentMessages?: (
    threadId: string,
    recipient: "orchestrator" | "subagent",
  ) => Promise<string[]>;
};

export type ToolHostOptions = {
  stellaRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  stellaComputerCliPath?: string;
  agentApi?: AgentToolApi;
  scheduleApi?: ScheduleToolApi;
  extensionTools?: import("../extensions/types.js").ToolDefinition[];
  displayHtml?: (html: string) => void;
  /**
   * Optional handler for Stella's search-backed `web` tool. When omitted,
   * search mode is unavailable. `displayResults` asks the implementation to
   * surface result cards in chat (orchestrator only).
   */
  webSearch?: (
    query: string,
    options?: { category?: string; displayResults?: boolean },
  ) => Promise<{
    text: string;
    results?: Array<{ title: string; url: string; snippet: string }>;
  }>;
  /**
   * Optional authenticated Stella site access for tool surfaces like `image_gen`
   * that call the managed media HTTP API.
   */
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  /**
   * Optional authenticated Convex query bridge for polling backend-owned state
   * such as media job completion.
   */
  queryConvex?: (
    ref: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /**
   * Optional MemoryStore wired to the orchestrator's memory surface.
   */
  memoryStore?: import("../memory/memory-store.js").MemoryStore;
  /**
   * Optional ThreadSummariesStore + stellaHome used by the background Dream
   * agent's consolidation pass.
   */
  threadSummariesStore?: import("../memory/thread-summaries-store.js").ThreadSummariesStore;
  stellaHome?: string;
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

/**
 * Self-contained tool definition. One file per tool under
 * `runtime/kernel/tools/defs/` exports either a `ToolDefinition` directly (for
 * stateless tools) or a `createXxxTool(options)` factory that returns one (for
 * tools that need wired dependencies like `webSearch`, `agentApi`, etc.).
 *
 * The host imports every def and builds a single Map<name, ToolDefinition>
 * that drives both:
 *   - the catalog the model sees (name, description, parameters, promptSnippet)
 *   - the handler the runtime dispatches (execute)
 *
 * No central description/schema map. No name-string lookup with placeholder
 * fallback. If a tool isn't in the registry, the agent loop simply doesn't
 * see it.
 */
export type ToolDefinition = {
  /** Tool name surfaced to the model (e.g. `web`, `exec_command`, `computer_click`). */
  name: string;
  /** Description string shown in the model's tool list. */
  description: string;
  /** JSON Schema for tool arguments. */
  parameters: Record<string, unknown>;
  /**
   * Optional one-line snippet for an auto-generated "Available tools" block in
   * the agent's system prompt. Tools omit this when their use is so context-
   * specific that an unconditional snippet would be misleading.
   */
  promptSnippet?: string;
  /** Handler invoked when the model calls the tool. */
  execute: ToolHandler;
};
