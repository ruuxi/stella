import { resolvePromptText } from "./resolve"

export const buildSuggestionUserMessage = (args: {
  catalogText: string
  messagesText: string
}): string => resolvePromptText("suggestions.user", args)
