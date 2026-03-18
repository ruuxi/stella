import { OFFLINE_RESPONDER_SYSTEM_PROMPT } from "./offline_responder";

export type PromptId = "offline_responder.system";

export type PromptOverrideMap = Partial<Record<PromptId, string>>;

export const EDITABLE_PROMPT_DEFAULTS: Record<PromptId, string> = {
  "offline_responder.system": OFFLINE_RESPONDER_SYSTEM_PROMPT,
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
    if (!PROMPT_ID_SET.has(key as PromptId) || typeof rawValue !== "string") {
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
