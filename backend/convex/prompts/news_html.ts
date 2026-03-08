export const NEWS_HTML_SYSTEM_PROMPT =
  "You generate clean, self-contained HTML for a news panel. No markdown fences. No explanation. Just HTML.";

export const NEWS_HTML_USER_PROMPT_TEMPLATE =
  "Output self-contained HTML that visually presents these results as a news feed. " +
  "Use semantic HTML (h2, h3, p, a, small). " +
  "For colors use var(--foreground) and var(--background). " +
  "Keep it concise and scannable. No scripts. No markdown fences.";

export const buildNewsHtmlUserPrompt = (args: {
  query: string;
  resultsText: string;
  promptTemplate?: string;
}): string =>
  `Generate a visual HTML news summary for the search query: "${args.query}"\n\n` +
  `Search results:\n${args.resultsText}\n\n` +
  (args.promptTemplate?.trim() || NEWS_HTML_USER_PROMPT_TEMPLATE);
