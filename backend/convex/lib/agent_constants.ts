export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  GENERAL: "general",
  OFFLINE_RESPONDER: "offline_responder",
} as const;

export type AgentType = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];

export const SUBAGENT_TYPES = [AGENT_IDS.GENERAL] as const;

export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export const BACKEND_TOOL_IDS = {
  WEB_SEARCH: "WebSearch",
  WEB_FETCH: "WebFetch",
  INTEGRATION_REQUEST: "IntegrationRequest",
  LIST_RESOURCES: "ListResources",
  NO_RESPONSE: "NoResponse",
} as const;

export type BackendToolId =
  (typeof BACKEND_TOOL_IDS)[keyof typeof BACKEND_TOOL_IDS];

export const BASE_BACKEND_TOOL_NAMES = [
  BACKEND_TOOL_IDS.WEB_SEARCH,
  BACKEND_TOOL_IDS.WEB_FETCH,
  BACKEND_TOOL_IDS.NO_RESPONSE,
] as const;

export const TRANSIENT_ALLOWED_BACKEND_TOOL_NAMES = [
  BACKEND_TOOL_IDS.WEB_SEARCH,
  BACKEND_TOOL_IDS.WEB_FETCH,
  BACKEND_TOOL_IDS.NO_RESPONSE,
] as const;

export const LOCAL_RUNTIME_BACKEND_TOOL_NAMES = [
  BACKEND_TOOL_IDS.WEB_SEARCH,
  BACKEND_TOOL_IDS.WEB_FETCH,
  BACKEND_TOOL_IDS.INTEGRATION_REQUEST,
  BACKEND_TOOL_IDS.LIST_RESOURCES,
  BACKEND_TOOL_IDS.NO_RESPONSE,
] as const;
