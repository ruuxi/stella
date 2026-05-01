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
      name: "look_at_screen",
      description:
        "Look at the user's screen to understand visible UI elements, buttons, menus, tabs, icons, or anything visible. " +
        "Prefer this whenever visual guidance would help: 'where is...', 'show me...', 'find the...', 'how do I...', 'what do I click...', 'what is this button...', or questions about the current app or current screen. " +
        "Err on the side of calling this for on-screen guidance instead of answering with words alone. " +
        "This captures the relevant screen(s) and passes the image directly into the voice conversation.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for on the screen, in the user's own words.",
          },
        },
        required: ["query"],
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
