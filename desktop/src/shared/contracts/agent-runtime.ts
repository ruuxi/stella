export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  SCHEDULE: "schedule",
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
  taskSubagent: boolean;
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
    taskSubagent: false,
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
    taskSubagent: false,
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
    taskSubagent: true,
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
    taskSubagent: false,
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
    taskSubagent: false,
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
    taskSubagent: false,
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
    taskSubagent: false,
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
  { taskSubagent: true }
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

export const DESKTOP_SUBAGENT_IDS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter((entry) => entry.taskSubagent).map(
    (entry) => entry.id,
  ) as DesktopSubagentId[],
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

export const AGENT_STREAM_EVENT_TYPES = {
  RUN_STARTED: "run-started",
  STREAM: "stream",
  STATUS: "status",
  TASK_REASONING: "task-reasoning",
  TOOL_START: "tool-start",
  TOOL_END: "tool-end",
  /** Legacy terminal event — prefer RUN_FINISHED. */
  ERROR: "error",
  /** Legacy terminal event — prefer RUN_FINISHED. */
  END: "end",
  RUN_FINISHED: "run-finished",
  TASK_STARTED: "task-started",
  TASK_COMPLETED: "task-completed",
  TASK_FAILED: "task-failed",
  TASK_CANCELED: "task-canceled",
  TASK_PROGRESS: "task-progress",
} as const;

export type AgentStreamEventType =
  (typeof AGENT_STREAM_EVENT_TYPES)[keyof typeof AGENT_STREAM_EVENT_TYPES];

export const AGENT_RUN_FINISH_OUTCOMES = {
  COMPLETED: "completed",
  ERROR: "error",
  CANCELED: "canceled",
} as const;

export type AgentRunFinishOutcome =
  (typeof AGENT_RUN_FINISH_OUTCOMES)[keyof typeof AGENT_RUN_FINISH_OUTCOMES];

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
  WEB_SEARCH: "WebSearch",
  WEB_FETCH: "WebFetch",
  NO_RESPONSE: "NoResponse",
  MEMORY: "Memory",
  DREAM: "Dream",
  READ: "Read",
  STR_REPLACE: "StrReplace",
} as const;

export type ToolId = (typeof TOOL_IDS)[keyof typeof TOOL_IDS];
