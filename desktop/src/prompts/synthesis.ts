import { resolvePromptText } from "./resolve"
import type { DiscoveryCategory } from "@/shared/contracts/discovery"
import type { PromptId } from "./types"

export type { HomeSuggestion } from "./types"

type CategoryAnalysisPromptId = Extract<
  PromptId,
  `synthesis.category_analysis.${string}.system`
>

const CATEGORY_ANALYSIS_PROMPT_IDS: Record<DiscoveryCategory, CategoryAnalysisPromptId> = {
  browsing_bookmarks: "synthesis.category_analysis.browsing_bookmarks.system",
  dev_environment: "synthesis.category_analysis.dev_environment.system",
  apps_system: "synthesis.category_analysis.apps_system.system",
  messages_notes: "synthesis.category_analysis.messages_notes.system",
}

export const getCategoryAnalysisPrompt = (category: DiscoveryCategory): string =>
  resolvePromptText(CATEGORY_ANALYSIS_PROMPT_IDS[category])

export const buildCategoryAnalysisUserMessage = (
  categoryLabel: string,
  data: string,
): string =>
  resolvePromptText("synthesis.category_analysis.user", { categoryLabel, data })

export const getCoreMemorySynthesisPrompt = (): string =>
  resolvePromptText("synthesis.core_memory.system")

export const CORE_MEMORY_SYNTHESIS_PROMPT = getCoreMemorySynthesisPrompt()

export const buildCoreSynthesisUserMessage = (rawOutputs: string): string =>
  resolvePromptText("synthesis.core_memory.user", { rawOutputs })

export const buildWelcomeMessagePrompt = (coreMemory: string): string =>
  resolvePromptText("synthesis.welcome_message.user", { coreMemory })

export const buildHomeSuggestionsPrompt = (coreMemory: string): string =>
  resolvePromptText("synthesis.home_suggestions.user", { coreMemory })
