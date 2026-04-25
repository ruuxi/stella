export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  SCHEDULE: "schedule",
  STORE: "store",
  FASHION: "fashion",
  GENERAL: "general",
  OFFLINE_RESPONDER: "offline_responder",
  EXPLORE: "explore",
  DREAM: "dream",
  CHRONICLE: "chronicle",
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
export type AgentIdLike = AgentId | (string & {});

type AgentPromptRole = "orchestrator" | "subagent";
type LocalCliWorkingDirectory = "home" | "frontend";
type AgentEnginePreferenceKey = "general";

type AgentModelSettings = {
  description?: string;
  order: number;
};

type AgentDefinition = {
  id: AgentId;
  name: string;
  description: string;
  activityLabel: string | null;
  bundledCore: boolean;
  runsAsSubagent: boolean;
  /** When false, omitted from the orchestrator-visible agent roster (internal flows only). */
  includeInAgentRoster?: boolean;
  usesLocalCliRuntime: boolean;
  promptRole: AgentPromptRole;
  includesStellaDocumentation: boolean;
  controlsSelfModHmr: boolean;
  localCliWorkingDirectory: LocalCliWorkingDirectory | null;
  agentEnginePreference: AgentEnginePreferenceKey | null;
  modelSettings: AgentModelSettings | null;
};

const BUILTIN_AGENT_DEFINITIONS = [
  {
    id: AGENT_IDS.ORCHESTRATOR,
    name: "Orchestrator",
    description:
      "Coordinates work across agents, talks to the user, manages memory and scheduling.",
    activityLabel: "Coordinating",
    bundledCore: true,
    runsAsSubagent: false,
    usesLocalCliRuntime: true,
    promptRole: "orchestrator",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: "frontend",
    agentEnginePreference: "general",
    modelSettings: {
      description: "Top-level agent that delegates tasks",
      order: 0,
    },
  },
  {
    id: AGENT_IDS.SCHEDULE,
    name: "Schedule",
    description:
      "Applies local cron and heartbeat changes from plain-language scheduling requests.",
    activityLabel: "Scheduling",
    bundledCore: true,
    runsAsSubagent: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: null,
  },
  {
    id: AGENT_IDS.STORE,
    name: "Store",
    description:
      "Helps the user assemble and publish self-mod commits to the Stella Store: inspects git history, groups commits into a release, and confirms metadata before publishing.",
    activityLabel: "Publishing",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: null,
  },
  {
    id: AGENT_IDS.FASHION,
    name: "Fashion",
    description:
      "Builds outfit batches for the Fashion tab: searches the global Shopify catalog, picks cohesive pieces across slots, and renders the user wearing each look on a white background by combining their body photo with product images.",
    activityLabel: "Styling",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: null,
  },
  {
    id: AGENT_IDS.GENERAL,
    name: "General",
    description:
      "Executes delegated work with a fixed base tool pack, Stella's life environment, and bundled native CLIs.",
    activityLabel: "Working",
    bundledCore: true,
    runsAsSubagent: true,
    usesLocalCliRuntime: true,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: "frontend",
    agentEnginePreference: "general",
    modelSettings: {
      description: "Single execution agent that works from files, manuals, and tools",
      order: 1,
    },
  },
  {
    id: AGENT_IDS.OFFLINE_RESPONDER,
    name: "Offline Responder",
    description: "Handles offline fallback responses.",
    activityLabel: "Responding",
    bundledCore: false,
    runsAsSubagent: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: null,
  },
  {
    id: AGENT_IDS.EXPLORE,
    name: "Explore",
    description:
      "Stateless one-shot helper. Reads state/ to surface relevant paths for an upcoming General task.",
    activityLabel: "Exploring",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: "general",
    modelSettings: null,
  },
  {
    id: AGENT_IDS.DREAM,
    name: "Dream",
    description:
      "Background memory consolidator. Reads thread_summaries + memories_extensions and surgically updates state/memories/ markdown files.",
    activityLabel: "Dreaming",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: "general",
    modelSettings: null,
  },
  {
    id: AGENT_IDS.CHRONICLE,
    name: "Chronicle",
    description:
      "Cheap recursive summarizer for the Chronicle OCR sidecar. Distills 10m and 6h windows of screen activity into short markdown blocks consumed by Dream.",
    activityLabel: "Chronicling",
    bundledCore: false,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: null,
  },
] as const satisfies readonly AgentDefinition[];

type BuiltInAgentDefinition = (typeof BUILTIN_AGENT_DEFINITIONS)[number];
export type DesktopSubagentId = Extract<
  BuiltInAgentDefinition,
  { runsAsSubagent: true }
>["id"];
export type LocalCliAgentId = Extract<
  BuiltInAgentDefinition,
  { usesLocalCliRuntime: true }
>["id"];
export type BundledCoreAgentId = Extract<
  BuiltInAgentDefinition,
  { bundledCore: true }
>["id"];

export const BUILTIN_AGENT_DEFINITION_BY_ID = Object.freeze(
  Object.fromEntries(
    BUILTIN_AGENT_DEFINITIONS.map((entry) => [entry.id, entry]),
  ) as Record<AgentId, BuiltInAgentDefinition>,
);

export const BUNDLED_CORE_AGENT_IDS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter((entry) => entry.bundledCore).map(
    (entry) => entry.id,
  ) as BundledCoreAgentId[],
);

export const MODEL_SETTINGS_AGENTS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter(
    (entry): entry is BuiltInAgentDefinition & { modelSettings: AgentModelSettings } =>
      entry.modelSettings !== null,
  )
    .sort((a, b) => a.modelSettings.order - b.modelSettings.order)
    .map((entry) => ({
      key: entry.id as AgentId,
      label: entry.name,
      desc: entry.modelSettings.description ?? entry.description,
    })),
);

const LOCAL_CLI_AGENT_ID_SET = new Set<string>(
  BUILTIN_AGENT_DEFINITIONS.filter((entry) => entry.usesLocalCliRuntime).map(
    (entry) => entry.id,
  ),
);

export const getAgentDefinition = (
  agentType: string,
): AgentDefinition | undefined =>
  BUILTIN_AGENT_DEFINITION_BY_ID[agentType as AgentId] as AgentDefinition;

export const getAgentActivityLabel = (agentType: string): string | null =>
  getAgentDefinition(agentType)?.activityLabel ?? null;

export const getAgentEnginePreference = (
  agentType: string,
): AgentEnginePreferenceKey | null =>
  getAgentDefinition(agentType)?.agentEnginePreference ?? null;

export const getLocalCliWorkingDirectory = (
  agentType: string,
): LocalCliWorkingDirectory | null =>
  getAgentDefinition(agentType)?.localCliWorkingDirectory ?? null;

export const isLocalCliAgentId = (
  agentType: string,
): agentType is LocalCliAgentId => LOCAL_CLI_AGENT_ID_SET.has(agentType);

export const isOrchestratorAgentType = (agentType: string): boolean =>
  getAgentDefinition(agentType)?.promptRole === "orchestrator";

export const shouldIncludeStellaDocumentation = (
  agentType: string,
): boolean => getAgentDefinition(agentType)?.includesStellaDocumentation ?? false;

// All IPC stream event types. RUN_FINISHED is the single terminal event for
// a run; per-agent lifecycle is the AGENT_* family below.
export const AGENT_STREAM_EVENT_TYPES = {
  RUN_STARTED: "run-started",
  RUN_FINISHED: "run-finished",
  STREAM: "stream",
  STATUS: "status",
  AGENT_REASONING: "agent-reasoning",
  TOOL_START: "tool-start",
  TOOL_END: "tool-end",
  AGENT_STARTED: "agent-started",
  AGENT_PROGRESS: "agent-progress",
  AGENT_COMPLETED: "agent-completed",
  AGENT_FAILED: "agent-failed",
  AGENT_CANCELED: "agent-canceled",
} as const;

export type AgentStreamEventType =
  (typeof AGENT_STREAM_EVENT_TYPES)[keyof typeof AGENT_STREAM_EVENT_TYPES];

// Per-agent lifecycle (subset of AGENT_STREAM_EVENT_TYPES). Tracks one
// subagent task from spawn to terminal state.
export const TASK_LIFECYCLE_EVENT_TYPES = [
  AGENT_STREAM_EVENT_TYPES.AGENT_STARTED,
  AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS,
  AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
  AGENT_STREAM_EVENT_TYPES.AGENT_FAILED,
  AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED,
] as const;

export type TaskLifecycleEventType = (typeof TASK_LIFECYCLE_EVENT_TYPES)[number];

export const TASK_LIFECYCLE_TERMINAL_TYPES = [
  AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
  AGENT_STREAM_EVENT_TYPES.AGENT_FAILED,
  AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED,
] as const;

export type TaskLifecycleTerminalType =
  (typeof TASK_LIFECYCLE_TERMINAL_TYPES)[number];

const TASK_LIFECYCLE_TYPE_SET: ReadonlySet<string> = new Set(
  TASK_LIFECYCLE_EVENT_TYPES,
);
const TASK_LIFECYCLE_TERMINAL_SET: ReadonlySet<string> = new Set(
  TASK_LIFECYCLE_TERMINAL_TYPES,
);

export const isTaskLifecycleEventType = (
  type: string,
): type is TaskLifecycleEventType => TASK_LIFECYCLE_TYPE_SET.has(type);

export const isTaskLifecycleTerminalType = (
  type: string,
): type is TaskLifecycleTerminalType => TASK_LIFECYCLE_TERMINAL_SET.has(type);

// Single status enum used by every layer that tracks a task's lifecycle
// state: TaskItem (UI), ConversationTaskSnapshot (IPC resume), and the
// runtime LocalAgentManager.
export type TaskLifecycleStatus = "running" | "completed" | "error" | "canceled";

export type TerminalTaskLifecycleStatus = Exclude<TaskLifecycleStatus, "running">;

export type TaskLifecycleFeedEventType =
  | typeof AGENT_STREAM_EVENT_TYPES.AGENT_REASONING
  | TaskLifecycleEventType;

export const isTerminalTaskLifecycleStatus = (
  status: TaskLifecycleStatus | undefined,
): status is TerminalTaskLifecycleStatus =>
  status === "completed" || status === "error" || status === "canceled";

export const shouldIgnoreTerminalTaskFeedEvent = (args: {
  currentStatus?: TaskLifecycleStatus;
  eventType: TaskLifecycleFeedEventType;
}): boolean => {
  if (!isTerminalTaskLifecycleStatus(args.currentStatus)) {
    return false;
  }
  return (
    args.eventType !== AGENT_STREAM_EVENT_TYPES.AGENT_STARTED
    && !isTaskLifecycleTerminalType(args.eventType)
  );
};

// Outcome of a single run (RUN_FINISHED). Mirrors the terminal subset of
// TaskLifecycleStatus.
export const AGENT_RUN_FINISH_OUTCOMES = {
  COMPLETED: "completed",
  ERROR: "error",
  CANCELED: "canceled",
} as const satisfies Record<string, TerminalTaskLifecycleStatus>;

export type AgentRunFinishOutcome = TerminalTaskLifecycleStatus;

// Internal runtime store event types (separate vocabulary because these
// are persisted to RuntimeStore and the schema is independent from IPC).
export const RUNTIME_RUN_EVENT_TYPES = {
  RUN_START: "run_start",
  STREAM: "stream",
  TOOL_START: "tool_start",
  TOOL_END: "tool_end",
  RUN_END: "run_end",
  ERROR: "error",
} as const;

export type RuntimeRunEventType =
  (typeof RUNTIME_RUN_EVENT_TYPES)[keyof typeof RUNTIME_RUN_EVENT_TYPES];

export const TOOL_IDS = {
  DISPLAY: "Display",
  NO_RESPONSE: "NoResponse",
  MEMORY: "Memory",
  DREAM: "Dream",
  READ: "Read",
  STR_REPLACE: "StrReplace",
} as const;

export type ToolId = (typeof TOOL_IDS)[keyof typeof TOOL_IDS];
