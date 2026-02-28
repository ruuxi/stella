/**
 * JSON Schema tool definition for the OpenAI Realtime API voice session.
 *
 * The voice layer has a single tool — `orchestrator_chat` — which delegates
 * all work to the existing orchestrator via the local agent runtime.
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
      name: "orchestrator_chat",
      description:
        "Send a request to Stella's orchestrator to execute tasks. Use this whenever the user asks you to DO something — read files, run commands, search, schedule, remember things, create or edit code, browse the web, etc. The orchestrator handles all tool execution and delegation. Pass the user's request as a natural language message. Wait for the full response before speaking it back.",
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
  ];
}
