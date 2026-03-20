export const AGENT_IDS = {
  ORCHESTRATOR: "orchestrator",
  GENERAL: "general",
  SELF_MOD: "self_mod",
  /** Onboarding personalized home dashboard pages (not general self-mod). */
  DASHBOARD_GENERATION: "dashboard_generation",
  EXPLORE: "explore",
  BROWSER: "browser",
  APP: "app",
  OFFLINE_RESPONDER: "offline_responder",
  AUTO: "auto",
} as const;

export type AgentType = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];

export const SKILLS_DISABLED_AGENT_TYPES = new Set<string>([AGENT_IDS.EXPLORE]);

export const SUBAGENT_TYPES = [
  AGENT_IDS.GENERAL,
  AGENT_IDS.SELF_MOD,
  AGENT_IDS.EXPLORE,
  AGENT_IDS.BROWSER,
  AGENT_IDS.APP,
] as const;

export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export const BACKEND_TOOL_IDS = {
  WEB_SEARCH: "WebSearch",
  WEB_FETCH: "WebFetch",
  INTEGRATION_REQUEST: "IntegrationRequest",
  ACTIVATE_SKILL: "ActivateSkill",
  GENERATE_API_SKILL: "GenerateApiSkill",
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
  BACKEND_TOOL_IDS.ACTIVATE_SKILL,
  BACKEND_TOOL_IDS.GENERATE_API_SKILL,
  BACKEND_TOOL_IDS.LIST_RESOURCES,
  BACKEND_TOOL_IDS.NO_RESPONSE,
] as const;

export const BROWSER_AGENT_SAFARI_DENIED_REASON =
  "Browser Agent is unavailable when the selected browser is Safari. Use a Chromium-based browser for browser automation.";
