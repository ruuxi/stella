/**
 * Shared type definitions for the tools system.
 */

import type { TaskLifecycleStatus } from "../../contracts/agent-runtime.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../../contracts/file-changes.js";
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
  toolWorkspaceRoot?: string;
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
  /**
   * Optional declarative gate: when set, only the listed agent types may see
   * the tool in their catalog and run it via executeTool. Replaces in-line
   * `agentType === ORCHESTRATOR` checks at the tool-handler layer.
   */
  agentTypes?: readonly string[];
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
  toolWorkspaceRoot?: string;
  rootRunId?: string;
  agentDepth?: number;
  maxAgentDepth?: number;
  parentAgentId?: string;
  threadId?: string;
  storageMode: "cloud" | "local";
  selfModMetadata?: {
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update" | "uninstall";
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
  messages?: Array<{
    from: "orchestrator" | "subagent";
    text: string;
    timestamp: number;
  }>;
};

export type AgentToolApi = {
  createAgent: (request: AgentToolRequest) => Promise<{
    threadId: string;
    activeThreads?: RuntimeThreadRecord[];
  }>;
  getAgent: (threadId: string) => Promise<AgentToolSnapshot | null>;
  cancelAgent: (
    threadId: string,
    reason?: string,
  ) => Promise<{ canceled: boolean }>;
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
  stellaComputerCliPath?: string;
  stellaConnectCliPath?: string;
  cliBridgeSocketPath?: string;
  agentApi?: AgentToolApi;
  getSubagentTypes?: () => readonly string[];
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
  extensionTools?: import("../extensions/types.js").ToolDefinition[];
  /**
   * Optional handler for Stella's search-backed `web` tool. When omitted,
   * search mode is unavailable.
   */
  webSearch?: (
    query: string,
    options?: { category?: string },
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
  notifyVoiceActionComplete?: (payload: {
    conversationId: string;
    status: "completed" | "failed";
    message: string;
  }) => Promise<void> | void;
};

export type FashionShopProduct = {
  productId: string;
  variantId: string;
  title: string;
  vendor?: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  merchantOrigin: string;
};

export type FashionShopProductDetail = FashionShopProduct & {
  variants?: Array<{
    variantId: string;
    title?: string;
    price?: number;
    currency?: string;
    available?: boolean;
    options?: Record<string, string>;
  }>;
};

export type FashionOutfitProductInput = {
  slot: string;
  productId: string;
  variantId: string;
  title: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  vendor?: string;
  merchantOrigin: string;
};

export type FashionContextSummary = {
  profile: {
    gender?: string;
    sizes?: Record<string, string>;
    stylePreferences?: string;
  } | null;
  recentLikes: Array<{ productId: string; title: string; vendor?: string }>;
  cart: Array<{ productId: string; title: string; quantity: number }>;
  recentOutfitProductIds: string[];
};

export type FashionCheckoutSessionResult = {
  checkoutId: string;
  status: string;
  continueUrl?: string;
  merchantOrigin: string;
  mcpEndpoint: string;
  usingMcp: boolean;
  cartUrl?: string;
};

/**
 * Fashion-tab Convex bridge.
 *
 * Mirrors `ScheduleToolApi`: a tight set of typed methods the Fashion subagent
 * (and the Fashion tab worker) calls into. Implementations live in the
 * runtime context layer and forward to `backend/convex/agent/local_runtime.ts`
 * so HTTP, auth, and rate-limits stay backend-side.
 */
export type FashionToolApi = {
  getOrchestratorContext: () => Promise<FashionContextSummary>;
  searchProducts: (args: {
    query: string;
    context?: string;
    limit?: number;
    savedCatalog?: string;
  }) => Promise<FashionShopProduct[]>;
  getProductDetails: (args: {
    productId: string;
  }) => Promise<FashionShopProductDetail | null>;
  registerOutfit: (args: {
    batchId: string;
    ordinal: number;
    themeLabel: string;
    themeDescription?: string;
    stylePrompt?: string;
    products: FashionOutfitProductInput[];
    tryOnPrompt?: string;
  }) => Promise<string>;
  markOutfitReady: (args: {
    outfitId: string;
    tryOnImagePath?: string;
    tryOnImageUrl?: string;
  }) => Promise<void>;
  markOutfitFailed: (args: {
    outfitId: string;
    errorMessage: string;
  }) => Promise<void>;
  createCheckout: (args: {
    merchantOrigin: string;
    lines: Array<{ variantId: string; quantity: number }>;
  }) => Promise<FashionCheckoutSessionResult>;
  cancelCheckout: (args: {
    mcpEndpoint: string;
    checkoutId: string;
  }) => Promise<{ checkoutId: string; status: string }>;
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
  /** Tool name surfaced to the model (e.g. `web`, `exec_command`). */
  name: string;
  /** Description string shown in the model's tool list. */
  description: string;
  /** JSON Schema for tool arguments. */
  parameters: Record<string, unknown>;
  /**
   * Optional declarative agent-type gate. When set, the tool is hidden from
   * agents not in the list (catalog filter) and rejected at executeTool if
   * the call still slips through. Prefer this over per-handler `agentType`
   * checks: it keeps gating colocated with the tool definition and makes the
   * surface area easy to audit.
   */
  agentTypes?: readonly string[];
  /**
   * Optional one-line snippet for an auto-generated "Available tools" block in
   * the agent's system prompt. Tools omit this when their use is so context-
   * specific that an unconditional snippet would be misleading.
   */
  promptSnippet?: string;
  /** Handler invoked when the model calls the tool. */
  execute: ToolHandler;
};
