export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  SCHEDULE: "schedule",
  GENERAL: "general",
  SELF_MOD: "self_mod",
  /** Onboarding personalized home dashboard pages (separate model config from self-mod). */
  DASHBOARD_GENERATION: "dashboard_generation",
  EXPLORE: "explore",
  APP: "app",
  BROWSER: "browser",
  OFFLINE_RESPONDER: "offline_responder",
  AUTO: "auto",
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
export type AgentIdLike = AgentId | (string & {});

type AgentPromptRole = "orchestrator" | "subagent";
type LocalCliWorkingDirectory = "home" | "frontend";
type AgentEnginePreferenceKey = "general" | "self_mod";

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
    usesLocalCliRuntime: false,
    promptRole: "orchestrator",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
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
      "Executes tasks: coding, file operations, shell commands, UI interaction, and web lookups.",
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
      description: "Full tool access for general tasks",
      order: 1,
    },
  },
  {
    id: AGENT_IDS.SELF_MOD,
    name: "Self Mod",
    description:
      "Modifies Stella itself: runtime, prompts, settings, dashboard UI, and internal product code.",
    activityLabel: "Modifying",
    bundledCore: true,
    taskSubagent: true,
    usesLocalCliRuntime: true,
    promptRole: "subagent",
    includesStellaDocumentation: true,
    controlsSelfModHmr: true,
    localCliWorkingDirectory: "frontend",
    agentEnginePreference: "self_mod",
    modelSettings: {
      description: "Stella internal code, prompts, runtime, and UI",
      order: 2,
    },
  },
  {
    id: AGENT_IDS.DASHBOARD_GENERATION,
    name: "Dashboard generation",
    description:
      "Creates personalized home dashboard panels during onboarding (React pages and registry updates).",
    activityLabel: "Building dashboard",
    bundledCore: true,
    taskSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: true,
    promptRole: "subagent",
    includesStellaDocumentation: true,
    controlsSelfModHmr: true,
    localCliWorkingDirectory: "frontend",
    agentEnginePreference: null,
    modelSettings: null,
  },
  {
    id: AGENT_IDS.EXPLORE,
    name: "Explore",
    description:
      "Read-only codebase investigation: searches files, reads code, traces imports.",
    activityLabel: "Exploring",
    bundledCore: true,
    taskSubagent: true,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: {
      description: "Lightweight read-only exploration",
      order: 4,
    },
  },
  {
    id: AGENT_IDS.APP,
    name: "App",
    description:
      "Controls applications: browser automation, desktop app control, navigation, forms, and screenshots.",
    activityLabel: "Browsing",
    bundledCore: true,
    taskSubagent: true,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: null,
  },
  {
    id: AGENT_IDS.BROWSER,
    name: "Browser",
    description: "Browser automation via Playwright.",
    activityLabel: "Browsing",
    bundledCore: false,
    taskSubagent: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    includesStellaDocumentation: false,
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    agentEnginePreference: null,
    modelSettings: {
      description: "Browser automation via Playwright",
      order: 3,
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
    id: AGENT_IDS.AUTO,
    name: "Auto",
    description: "Runs auto-panel requests and background automation flows.",
    activityLabel: null,
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

export const shouldControlSelfModHmr = (agentType: string): boolean =>
  getAgentDefinition(agentType)?.controlsSelfModHmr ?? false;

export const shouldIncludeStellaDocumentation = (
  agentType: string,
): boolean => getAgentDefinition(agentType)?.includesStellaDocumentation ?? false;

export const AGENT_STREAM_EVENT_TYPES = {
  STREAM: "stream",
  TOOL_START: "tool-start",
  TOOL_END: "tool-end",
  ERROR: "error",
  END: "end",
  TASK_STARTED: "task-started",
  TASK_COMPLETED: "task-completed",
  TASK_FAILED: "task-failed",
  TASK_CANCELED: "task-canceled",
  TASK_PROGRESS: "task-progress",
} as const;

export type AgentStreamEventType =
  (typeof AGENT_STREAM_EVENT_TYPES)[keyof typeof AGENT_STREAM_EVENT_TYPES];

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
  ACTIVATE_SKILL: "ActivateSkill",
  NO_RESPONSE: "NoResponse",
  SAVE_MEMORY: "SaveMemory",
  RECALL_MEMORIES: "RecallMemories",
} as const;

export type ToolId = (typeof TOOL_IDS)[keyof typeof TOOL_IDS];
