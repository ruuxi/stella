import { resolvePromptText } from "./resolve"

export type { WelcomeSuggestion } from "./types"

export const getCoreMemorySynthesisPrompt = (): string =>
  resolvePromptText("synthesis.core_memory.system")

export const CORE_MEMORY_SYNTHESIS_PROMPT = getCoreMemorySynthesisPrompt()

export const buildCoreSynthesisUserMessage = (rawOutputs: string): string =>
  resolvePromptText("synthesis.core_memory.user", { rawOutputs })

export const buildWelcomeMessagePrompt = (coreMemory: string): string =>
  resolvePromptText("synthesis.welcome_message.user", { coreMemory })

export const buildWelcomeSuggestionsPrompt = (coreMemory: string): string =>
  resolvePromptText("synthesis.welcome_suggestions.user", { coreMemory })
