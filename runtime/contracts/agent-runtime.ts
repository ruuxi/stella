export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  SCHEDULE: "schedule",
  FASHION: "fashion",
  GENERAL: "general",
  SOCIAL_SESSION: "social_session",
  OFFLINE_RESPONDER: "offline_responder",
  EXPLORE: "explore",
  DREAM: "dream",
  CHRONICLE: "chronicle",
  OPEN_PANEL_REPORTS: "open_panel_reports",
  INSTALL_UPDATE: "install_update",
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
export type AgentIdLike = AgentId | (string & {});

type AgentPromptRole = "orchestrator" | "subagent";
type LocalCliWorkingDirectory = "home" | "frontend";
type AgentModelSettings = {
  description?: string;
  order: number;
};

/**
 * Declarative runtime behaviors for each agent. Unset flags default to false,
 * and steering defaults to "one-at-a-time".
 */
export type AgentCapabilities = {
  /** Steering queue mode for this agent's runs. Defaults to "one-at-a-time". */
  steeringMode?: "all" | "one-at-a-time";
  /** Follow-up queue mode for this agent's runs. Defaults to "one-at-a-time". */
  followUpMode?: "all" | "one-at-a-time";
  /**
   * Load the user's selected personality preset into the agent context so it
   * is injected as a hidden `~/.stella/PERSONALITY.md` startup doc on the
   * first turn (then replayed from history), mirroring core memory.
   */
  injectsPersonality?: boolean;
  /**
   * Load the user's core memory into the agent context so it is injected as a
   * hidden `~/.stella/core-memory.md` startup doc on the first turn.
   */
  injectsCoreMemory?: boolean;
  /** Inject the dynamic memory bundle on the every-Nth-turn cadence. */
  injectsDynamicMemory?: boolean;
  /** Inject runtime reminder hidden messages. */
  injectsRuntimeReminders?: boolean;
  /** Inject the skill catalog block into the dynamic context. */
  injectsSkillCatalog?: boolean;
  /** Inject the available-subagents roster block into the dynamic context. */
  injectsSubagentRoster?: boolean;
  /** Queue a Dream-inbox thread-summary row on successful run completion. */
  recordsThreadSummary?: boolean;
  /** Notify the Dream scheduler on successful run completion. */
  triggersDreamScheduler?: boolean;
  /** Trigger the orchestrator memory-review pass on successful real user turns. */
  triggersMemoryReview?: boolean;
  /** Run self-mod baseline capture and detect-applied around the run. */
  triggersSelfModDetection?: boolean;
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
  controlsSelfModHmr: boolean;
  localCliWorkingDirectory: LocalCliWorkingDirectory | null;
  modelSettings: AgentModelSettings | null;
  /** Optional capability bundle. Defaults to no capabilities. */
  capabilities?: AgentCapabilities;
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
    controlsSelfModHmr: false,
    localCliWorkingDirectory: "frontend",
    modelSettings: {
      description: "Top-level agent that delegates tasks",
      order: 0,
    },
    capabilities: {
      steeringMode: "all",
      followUpMode: "all",
      injectsPersonality: true,
      injectsCoreMemory: true,
      injectsDynamicMemory: true,
      injectsRuntimeReminders: true,
      injectsSkillCatalog: true,
      injectsSubagentRoster: true,
      triggersDreamScheduler: true,
      triggersMemoryReview: true,
      triggersSelfModDetection: true,
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
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Turns plain-language requests into local schedules",
      order: 2,
    },
  },
  {
    id: AGENT_IDS.FASHION,
    name: "Fashion",
    description:
      "Builds outfit batches for the Fashion tab: searches the global Shopify catalog, picks cohesive pieces across slots, and renders the user wearing each look on a clean white studio background by combining their body photo with product images.",
    activityLabel: "Styling",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Builds outfit looks and fashion outputs",
      order: 8,
    },
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
    controlsSelfModHmr: false,
    localCliWorkingDirectory: "frontend",
    modelSettings: {
      description:
        "Single execution agent that works from files, manuals, and tools",
      order: 1,
    },
    capabilities: {
      injectsSkillCatalog: true,
      // Subagents queue Dream-inbox thread summaries for Dream to consume, but they
      // do not trigger Dream — consolidation is driven by orchestrator context
      // growth, so these rows are folded on the next orchestrator-driven run.
      recordsThreadSummary: true,
    },
  },
  {
    id: AGENT_IDS.SOCIAL_SESSION,
    name: "Social Session",
    description:
      "Works inside a shared Stella Together folder with a path-scoped file tool surface.",
    activityLabel: "Collaborating",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Works inside shared Stella Together folders",
      order: 10,
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
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Responds when Stella is offline",
      order: 9,
    },
  },
  {
    id: AGENT_IDS.OPEN_PANEL_REPORTS,
    name: "Open Panel Reports",
    description:
      "Generates background HTML briefs for the Open panel cadence pills.",
    activityLabel: "Briefing",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Generates Open panel cadence reports",
      order: 11,
    },
  },
  {
    id: AGENT_IDS.EXPLORE,
    name: "Explore",
    description:
      "Stateless one-shot helper. Reads ~/.stella/ to surface relevant paths for an upcoming General task.",
    activityLabel: "Exploring",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Finds relevant context before a task starts",
      order: 3,
    },
  },
  {
    id: AGENT_IDS.DREAM,
    name: "Dream",
    description:
      "Background memory consolidator. Reads the Dream inbox and surgically updates ~/.stella/memories/ markdown files.",
    activityLabel: "Dreaming",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Consolidates memory in the background",
      order: 5,
    },
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
    controlsSelfModHmr: false,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Summarizes screen activity for memory",
      order: 6,
    },
  },
  {
    id: AGENT_IDS.INSTALL_UPDATE,
    name: "Install Update",
    description:
      "Integrates an upstream Stella update into the user's local fork via Stella source-pack conflict resolution or a real `git merge` fallback. Restricted to a narrow git plus dependency-install exec_command allowlist; biases toward preserving the user's customizations on conflicts.",
    activityLabel: "Updating",
    bundledCore: true,
    runsAsSubagent: false,
    includeInAgentRoster: false,
    usesLocalCliRuntime: false,
    promptRole: "subagent",
    controlsSelfModHmr: true,
    localCliWorkingDirectory: null,
    modelSettings: {
      description: "Applies Stella updates",
      order: 7,
    },
  },
] as const satisfies readonly AgentDefinition[];

type BuiltInAgentDefinition = (typeof BUILTIN_AGENT_DEFINITIONS)[number];
type LocalCliAgentId = Extract<
  BuiltInAgentDefinition,
  { usesLocalCliRuntime: true }
>["id"];
type BundledCoreAgentId = Extract<
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

export const ORCHESTRATOR_RESERVED_BUILTIN_AGENT_IDS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter(
    (entry) => entry.id !== AGENT_IDS.GENERAL,
  ).map((entry) => entry.id) as AgentId[],
);

const ORCHESTRATOR_RESERVED_BUILTIN_AGENT_ID_SET = new Set<string>(
  ORCHESTRATOR_RESERVED_BUILTIN_AGENT_IDS,
);

export const isOrchestratorReservedBuiltinAgentId = (
  agentId: string,
): boolean => ORCHESTRATOR_RESERVED_BUILTIN_AGENT_ID_SET.has(agentId);

export const MODEL_SETTINGS_AGENTS = Object.freeze(
  BUILTIN_AGENT_DEFINITIONS.filter(
    (
      entry,
    ): entry is BuiltInAgentDefinition & {
      modelSettings: AgentModelSettings;
    } => entry.modelSettings !== null,
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

export const getLocalCliWorkingDirectory = (
  agentType: string,
): LocalCliWorkingDirectory | null =>
  getAgentDefinition(agentType)?.localCliWorkingDirectory ?? null;

export const isLocalCliAgentId = (
  agentType: string,
): agentType is LocalCliAgentId => LOCAL_CLI_AGENT_ID_SET.has(agentType);

export const isOrchestratorAgentType = (agentType: string): boolean =>
  getAgentDefinition(agentType)?.promptRole === "orchestrator";

/** Resolve declarative capabilities for an agent. */
export const getAgentCapabilities = (agentType: string): AgentCapabilities =>
  getAgentDefinition(agentType)?.capabilities ?? {};

export const agentHasCapability = (
  agentType: string,
  capability: keyof AgentCapabilities,
): boolean => {
  const value = getAgentCapabilities(agentType)[capability];
  return value !== undefined && value !== false;
};

export const agentControlsSelfModHmr = (agentType: string): boolean =>
  getAgentDefinition(agentType)?.controlsSelfModHmr === true;

export const getAgentSteeringMode = (
  agentType: string,
): "all" | "one-at-a-time" =>
  getAgentCapabilities(agentType).steeringMode ?? "one-at-a-time";

export const getAgentFollowUpMode = (
  agentType: string,
): "all" | "one-at-a-time" =>
  getAgentCapabilities(agentType).followUpMode ?? "one-at-a-time";

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
  /**
   * Boundary between two consecutive assistant messages within a single
   * orchestrator run (e.g. preamble → post-tool answer). Carries the
   * persisted eventId of the message that just finalized so the renderer
   * can reset its in-flight streaming buffer before chunks for the next
   * message arrive on the same channel.
   */
  ASSISTANT_MESSAGE: "assistant-message",
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

export type TaskLifecycleEventType =
  (typeof TASK_LIFECYCLE_EVENT_TYPES)[number];

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
export type TaskLifecycleStatus =
  | "running"
  | "completed"
  | "error"
  | "canceled";

export type TerminalTaskLifecycleStatus = Exclude<
  TaskLifecycleStatus,
  "running"
>;

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
    args.eventType !== AGENT_STREAM_EVENT_TYPES.AGENT_STARTED &&
    !isTaskLifecycleTerminalType(args.eventType)
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

export const TOOL_IDS = {
  NO_RESPONSE: "NoResponse",
  DREAM: "Dream",
  READ: "Read",
  STR_REPLACE: "StrReplace",
} as const;
