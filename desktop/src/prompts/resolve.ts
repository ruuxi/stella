import { getPromptDefinition } from "./catalog"
import { getPromptOverride } from "./storage"
import type { PromptId, PromptTemplateValues, ResolvedPrompt } from "./types"

export const getPromptTemplateText = <TId extends PromptId>(promptId: TId): string => {
  const definition = getPromptDefinition(promptId)
  return getPromptOverride(promptId) ?? definition.defaultText
}

export const resolvePrompt = <TId extends PromptId>(
  promptId: TId,
  values?: PromptTemplateValues[TId],
): ResolvedPrompt<TId> => {
  const definition = getPromptDefinition(promptId)
  const override = getPromptOverride(promptId)
  const template = getPromptTemplateText(promptId)

  return {
    id: definition.id,
    module: definition.module,
    title: definition.title,
    defaultText: definition.defaultText,
    text: definition.render(template, values as PromptTemplateValues[TId]),
    overridden: override !== null,
  }
}

export const resolvePromptText = <TId extends PromptId>(
  promptId: TId,
  values?: PromptTemplateValues[TId],
): string => resolvePrompt(promptId, values).text
