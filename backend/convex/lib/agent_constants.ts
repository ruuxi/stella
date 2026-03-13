export const SKILLS_DISABLED_AGENT_TYPES = new Set(["explore"]);

export const SUBAGENT_TYPES = ["general", "self_mod", "explore", "browser"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export const BROWSER_AGENT_SAFARI_DENIED_REASON =
  "Browser Agent is unavailable when the selected browser is Safari. Use a Chromium-based browser for browser automation.";
