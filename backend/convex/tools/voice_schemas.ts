/**
 * JSON Schema tool definitions for the OpenAI Realtime API voice session.
 *
 * The voice layer has a single tool — `perform_action` — which handles
 * all user requests that go beyond simple conversation.
 */

export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function getVoiceToolSchemas(): VoiceToolSchema[] {
  return [
    {
      type: "function",
      name: "web_search",
      description:
        "Search the web for current information. Use natural language queries, not keywords. " +
        "Call this for any question needing up-to-date facts: news, prices, current events, people's roles, product info. " +
        "Results are displayed on the canvas panel. Speak a concise summary of the key findings.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "perform_action",
      description:
        "Execute an action on behalf of the user. Call this for ANY request that involves doing something beyond casual conversation or web search: " +
        "opening/closing the dashboard, creating content, managing files, running tasks, setting reminders, browsing specific URLs, or complex multi-step operations.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "no_response",
      description:
        "Stay silent and wait for the user to finish. Call this when the user is still thinking — filler sounds like \"hmm,\" \"um,\" \"uh,\" half-finished sentences, trailing off, or any indication they haven't completed their thought yet. Also use for ambient noise or unclear audio that isn't a real utterance. Examples: \"I want to...\" / \"So maybe we could\" / \"Hmm\" / \"Let me think\" / \"What if we—\"",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "goodbye",
      description:
        "End the voice conversation. Call this when the user says goodbye, bye, see you later, goodnight, or otherwise indicates they want to stop talking.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];
}
