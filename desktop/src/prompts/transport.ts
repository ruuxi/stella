import { loadPromptOverrides } from "./storage";
import type { PromptId, PromptOverrideMap } from "./types";

export const getPromptOverridesPayload = (
  promptIds: PromptId[],
): { promptOverrides?: PromptOverrideMap } => {
  const allOverrides = loadPromptOverrides();
  const promptOverrides: PromptOverrideMap = {};

  for (const promptId of promptIds) {
    const value = allOverrides[promptId];
    if (typeof value === "string" && value.trim().length > 0) {
      promptOverrides[promptId] = value.trim();
    }
  }

  return Object.keys(promptOverrides).length > 0 ? { promptOverrides } : {};
};
