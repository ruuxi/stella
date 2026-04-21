/**
 * `dream.markProcessed` Exec builtin.
 *
 * Stamps thread_summaries rows + memories_extensions/* paths as consumed and
 * persists the new Dream watermark.
 */

import {
  dreamMarkProcessed,
  type DreamMarkProcessedArgs,
} from "../../../memory/dream-core.js";
import type { ThreadSummariesStore } from "../../../memory/thread-summaries-store.js";
import type { ExecToolDefinition } from "../registry.js";

const SCHEMA = {
  type: "object",
  properties: {
    threadKeys: {
      type: "array",
      description: "Concrete (threadId, runId) pairs to mark processed.",
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
        "Mark every unprocessed run for these threadIds. Useful when summarizing in bulk.",
      items: { type: "string" },
    },
    extensionPaths: {
      type: "array",
      description: "memories_extensions/* file paths consumed in this run.",
      items: { type: "string" },
    },
    watermark: {
      type: "number",
      description: "Explicit watermark to persist (defaults to now).",
    },
  },
} as const;

export type DreamWatermarkBuiltinOptions = {
  stellaHome: string;
  threadSummariesStore: ThreadSummariesStore;
  agentTypes?: readonly string[];
};

const isThreadKeyArray = (
  value: unknown,
): value is Array<{ threadId: string; runId: string }> =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      typeof (entry as { threadId?: unknown }).threadId === "string" &&
      typeof (entry as { runId?: unknown }).runId === "string",
  );

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const createDreamWatermarkBuiltin = (
  options: DreamWatermarkBuiltinOptions,
): ExecToolDefinition => ({
  name: "dream.markProcessed",
  description:
    "Mark thread_summaries rows + memories_extensions paths as consumed and advance the Dream watermark.",
  ...(options.agentTypes ? { agentTypes: options.agentTypes } : {}),
  inputSchema: SCHEMA,
  handler: async (rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const callArgs: DreamMarkProcessedArgs = {
      stellaHome: options.stellaHome,
      store: options.threadSummariesStore,
    };
    if (isThreadKeyArray(args.threadKeys)) {
      callArgs.threadKeys = args.threadKeys;
    }
    if (isStringArray(args.threadIds)) {
      callArgs.threadIds = args.threadIds;
    }
    if (isStringArray(args.extensionPaths)) {
      callArgs.extensionPaths = args.extensionPaths;
    }
    if (typeof args.watermark === "number") {
      callArgs.watermark = args.watermark;
    }
    return dreamMarkProcessed(callArgs);
  },
});
