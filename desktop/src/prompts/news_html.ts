import { resolvePromptText } from "./resolve"

export const getNewsHtmlSystemPrompt = (): string => resolvePromptText("news_html.system")

export const NEWS_HTML_SYSTEM_PROMPT = getNewsHtmlSystemPrompt()

export const buildNewsHtmlUserPrompt = (args: {
  query: string
  resultsText: string
}): string => resolvePromptText("news_html.user", args)
