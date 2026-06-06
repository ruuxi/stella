import type { ToolDefinition } from "../types.js";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export const toolSearchTool: ToolDefinition = {
  name: TOOL_SEARCH_TOOL_NAME,
  label: "Search tools",
  workingText: "Searching tools",
  description:
    "Search deferred tools and expose matching tools for the next model call.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What capability you need, such as iMessage reactions, rich links, voice memos, contact cards, media, or message effects.",
      },
      limit: {
        type: "number",
        description: "Maximum number of tools to expose. Defaults to 6.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  promptSnippet: "Search and expose deferred tools for specialized capabilities",
  execute: async () => ({
    error:
      "tool_search is handled by the runtime adapter and is not available through direct host execution.",
  }),
};
