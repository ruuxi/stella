type PromptTemplateValues = {
  "voice_orchestrator.base": undefined
  "synthesis.category_analysis.browsing_bookmarks.system": undefined
  "synthesis.category_analysis.dev_environment.system": undefined
  "synthesis.category_analysis.apps_system.system": undefined
  "synthesis.category_analysis.messages_notes.system": undefined
  "synthesis.category_analysis.user": {
    categoryLabel: string
    data: string
  }
  "synthesis.core_memory.system": undefined
  "synthesis.core_memory.user": {
    rawOutputs: string
  }
  "synthesis.welcome_message.user": {
    coreMemory: string
  }
  "synthesis.home_suggestions.user": {
    coreMemory: string
  }
}

export type PromptId = keyof PromptTemplateValues

export type PromptDefinition<TId extends PromptId = PromptId> = {
  id: TId
  module: string
  title: string
  defaultText: string
  render: (template: string, values: PromptTemplateValues[TId]) => string
}

export type PromptCatalog = {
  [TId in PromptId]: PromptDefinition<TId>
}
