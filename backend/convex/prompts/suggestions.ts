export const buildSuggestionUserMessage = (args: {
  catalogText: string;
  messagesText: string;
}): string => `Based on the recent conversation, suggest 0-3 commands the user might want to run next.
Only suggest commands that are clearly relevant to the conversation context. Return an empty array if nothing fits.

## Available Commands
${args.catalogText}

## Recent Conversation
${args.messagesText}

Return ONLY a JSON array (no markdown fences). Each element: {"commandId": "...", "name": "...", "description": "..."}
If no commands are relevant, return: []`;
