import { getPromptTemplateText } from "./resolve";

export const getVoiceSessionPromptConfig = (): { basePrompt: string } => ({
  basePrompt: getPromptTemplateText("voice_orchestrator.base").trim(),
})

export const getSynthesisPromptConfig = () => ({
  categoryAnalysisSystemPrompts: {
    browsing_bookmarks: getPromptTemplateText("synthesis.category_analysis.browsing_bookmarks.system").trim(),
    dev_environment: getPromptTemplateText("synthesis.category_analysis.dev_environment.system").trim(),
    apps_system: getPromptTemplateText("synthesis.category_analysis.apps_system.system").trim(),
    messages_notes: getPromptTemplateText("synthesis.category_analysis.messages_notes.system").trim(),
  } as Record<string, string>,
  categoryAnalysisUserPromptTemplate: getPromptTemplateText("synthesis.category_analysis.user").trim(),
  coreMemorySystemPrompt: getPromptTemplateText("synthesis.core_memory.system").trim(),
  coreMemoryUserPromptTemplate: getPromptTemplateText("synthesis.core_memory.user").trim(),
  welcomeMessagePromptTemplate: getPromptTemplateText("synthesis.welcome_message.user").trim(),
  homeSuggestionsPromptTemplate: getPromptTemplateText("synthesis.home_suggestions.user").trim(),
})

