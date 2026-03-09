import { SEARCH_HTML_SYSTEM_PROMPT, SEARCH_HTML_USER_PROMPT_TEMPLATE } from "./search_html";
import { OFFLINE_RESPONDER_SYSTEM_PROMPT } from "./offline_responder";
import {
  PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  PERSONALIZED_DASHBOARD_PAGE_USER_PROMPT_TEMPLATE,
} from "./personalized_dashboard";
import { SKILL_METADATA_PROMPT, SKILL_METADATA_USER_PROMPT_TEMPLATE } from "./skill_metadata";
import { SKILL_SELECTION_PROMPT, SKILL_SELECTION_USER_PROMPT_TEMPLATE } from "./skill_selection";
import { SUGGESTIONS_USER_PROMPT_TEMPLATE } from "./suggestions";
import {
  CORE_MEMORY_SYNTHESIS_PROMPT,
  CORE_MEMORY_SYNTHESIS_USER_PROMPT_TEMPLATE,
  WELCOME_MESSAGE_PROMPT_TEMPLATE,
  WELCOME_SUGGESTIONS_PROMPT_TEMPLATE,
} from "./synthesis";
import { VOICE_ORCHESTRATOR_PROMPT } from "./voice_orchestrator";

export type PromptId =
  | "offline_responder.system"
  | "search_html.system"
  | "search_html.user"
  | "voice_orchestrator.base"
  | "synthesis.core_memory.system"
  | "synthesis.core_memory.user"
  | "synthesis.welcome_message.user"
  | "synthesis.welcome_suggestions.user"
  | "skill_metadata.system"
  | "skill_metadata.user"
  | "skill_selection.system"
  | "skill_selection.user"
  | "personalized_dashboard.system"
  | "personalized_dashboard.user"
  | "suggestions.user";

export type PromptOverrideMap = Partial<Record<PromptId, string>>;

export const EDITABLE_PROMPT_DEFAULTS: Record<PromptId, string> = {
  "offline_responder.system": OFFLINE_RESPONDER_SYSTEM_PROMPT,
  "search_html.system": SEARCH_HTML_SYSTEM_PROMPT,
  "search_html.user": SEARCH_HTML_USER_PROMPT_TEMPLATE,
  "voice_orchestrator.base": VOICE_ORCHESTRATOR_PROMPT,
  "synthesis.core_memory.system": CORE_MEMORY_SYNTHESIS_PROMPT,
  "synthesis.core_memory.user": CORE_MEMORY_SYNTHESIS_USER_PROMPT_TEMPLATE,
  "synthesis.welcome_message.user": WELCOME_MESSAGE_PROMPT_TEMPLATE,
  "synthesis.welcome_suggestions.user": WELCOME_SUGGESTIONS_PROMPT_TEMPLATE,
  "skill_metadata.system": SKILL_METADATA_PROMPT,
  "skill_metadata.user": SKILL_METADATA_USER_PROMPT_TEMPLATE,
  "skill_selection.system": SKILL_SELECTION_PROMPT,
  "skill_selection.user": SKILL_SELECTION_USER_PROMPT_TEMPLATE,
  "personalized_dashboard.system": PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  "personalized_dashboard.user": PERSONALIZED_DASHBOARD_PAGE_USER_PROMPT_TEMPLATE,
  "suggestions.user": SUGGESTIONS_USER_PROMPT_TEMPLATE,
};

const PROMPT_ID_SET = new Set<PromptId>(Object.keys(EDITABLE_PROMPT_DEFAULTS) as PromptId[]);

export const normalizePromptOverrides = (
  value: unknown,
): PromptOverrideMap | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized: PromptOverrideMap = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!PROMPT_ID_SET.has(key as PromptId)) {
      continue;
    }
    if (typeof rawValue !== "string") {
      continue;
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
      continue;
    }
    normalized[key as PromptId] = trimmed;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const resolvePromptText = (
  promptId: PromptId,
  overrides?: PromptOverrideMap,
): string => {
  const override = overrides?.[promptId];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return EDITABLE_PROMPT_DEFAULTS[promptId];
};
