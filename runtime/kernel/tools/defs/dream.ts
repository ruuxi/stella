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
    'Background memory consolidator IO. action="list" returns unprocessed Dream-inbox rows (thread summaries, memory notes, chronicle digests); action="markProcessed" stamps rows as consumed by id.',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "markProcessed"],
        description:
          "list = fetch unprocessed inbox rows, oldest first. markProcessed = stamp the given row ids as consumed.",
      },
      limit: {
        type: "number",
        description:
          "Optional cap on rows returned by list (default 50, max 500).",
      },
      ids: {
        type: "array",
        description:
          "markProcessed: inbox row ids (from list) to stamp as processed.",
        items: { type: "number" },
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
