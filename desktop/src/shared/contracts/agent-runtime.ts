export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  GENERAL: "general",
  SELF_MOD: "self_mod",
  EXPLORE: "explore",
  APP: "app",
  BROWSER: "browser",
  OFFLINE_RESPONDER: "offline_responder",
  AUTO: "auto",
} as const;

export type AgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
export type AgentIdLike = AgentId | (string & {});

export const DESKTOP_SUBAGENT_IDS = [
  AGENT_IDS.GENERAL,
  AGENT_IDS.SELF_MOD,
  AGENT_IDS.EXPLORE,
  AGENT_IDS.APP,
] as const;

export type DesktopSubagentId = (typeof DESKTOP_SUBAGENT_IDS)[number];

export const LOCAL_CLI_AGENT_IDS = [
  AGENT_IDS.GENERAL,
  AGENT_IDS.SELF_MOD,
] as const;

export type LocalCliAgentId = (typeof LOCAL_CLI_AGENT_IDS)[number];

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
