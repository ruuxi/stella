/**
 * `Dream` — background memory-consolidator IO, used exclusively by the
 * Dream subagent.
 *
 * Dream's runtime intercepts via `dispatchLocalTool`. The host doesn't have
 * an unrestricted handler — calling it outside the Dream subagent returns
 * an error.
 */

import type { ToolDefinition } from "../types.js";

export const dreamTool: ToolDefinition = {
  name: "Dream",
  description:
    'Background memory consolidator IO. action="list" returns unprocessed thread_summaries + pending memories_extensions paths; action="markProcessed" advances the Dream watermark data.',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "markProcessed"],
        description:
          "list = fetch unprocessed thread_summaries + memories_extensions newer than the persisted Dream state. markProcessed = stamp rows + extension paths as consumed.",
      },
      sinceWatermark: {
        type: "number",
        description:
          "Optional Unix epoch ms override for thread_summaries returned by list.",
      },
      limit: {
        type: "number",
        description: "Optional cap on rows returned by list (default 50, max 500).",
      },
      threadKeys: {
        type: "array",
        description:
          "markProcessed: list of {threadId, runId} pairs to stamp as processed.",
        items: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            runId: { type: "string" },
          },
          required: ["threadId", "runId"],
        },
      },
      threadIds: {
        type: "array",
        description:
          "markProcessed: shortcut to mark every unprocessed run for these threadIds.",
        items: { type: "string" },
      },
      extensionPaths: {
        type: "array",
        description:
          "markProcessed: list of memories_extensions/* file paths the agent consumed.",
        items: { type: "string" },
      },
      watermark: {
        type: "number",
        description:
          "markProcessed: explicit watermark to persist. Defaults to now.",
      },
    },
    required: ["action"],
  },
  execute: async () => ({
    error:
      "Dream is only available inside the Dream subagent runtime " +
      "(which routes the call through restricted local dispatch).",
  }),
};
