import { getPromptDefinition } from "./catalog"
import { getPromptOverride } from "./storage"
import type { PromptId } from "./types"

export const getPromptTemplateText = <TId extends PromptId>(promptId: TId): string => {
  const definition = getPromptDefinition(promptId)
  return getPromptOverride(promptId) ?? definition.defaultText
}
