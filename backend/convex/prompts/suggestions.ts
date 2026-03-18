export const SUGGESTIONS_USER_PROMPT_TEMPLATE =
  "Based on the recent conversation, suggest 0-3 commands the user might want to run next.\n" +
  "Only suggest commands that are clearly relevant to the conversation context. Return an empty array if nothing fits.\n\n" +
  'Return ONLY a JSON array (no markdown fences). Each element: {"commandId": "...", "name": "...", "description": "..."}\n' +
  "If no commands are relevant, return: []";

export const buildSuggestionUserMessage = (args: {
  catalogText: string;
  messagesText: string;
  promptTemplate?: string;
}): string => `${args.promptTemplate?.trim() || SUGGESTIONS_USER_PROMPT_TEMPLATE}

## Available Commands
${args.catalogText}

## Recent Conversation
${args.messagesText}`;
