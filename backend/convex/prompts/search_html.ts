export const buildSearchHtmlUserPrompt = (args: {
  query: string;
  resultsText: string;
  promptTemplate: string;
}): string =>
  `Generate a visual HTML summary for: "${args.query}"\n\n` +
  `Search results:\n${args.resultsText}\n\n` +
  args.promptTemplate.trim();
