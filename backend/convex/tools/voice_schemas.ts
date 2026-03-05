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
      name: "perform_action",
      description:
        "Execute an action on behalf of the user. Use this for ANY request that involves doing something: searching, opening/closing the dashboard, creating content, managing files, running tasks, setting reminders, browsing the web, or anything beyond casual conversation. Pass the user's request as a natural language message.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The user's request in natural language",
          },
        },
        required: ["message"],
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
