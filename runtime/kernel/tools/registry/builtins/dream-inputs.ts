/**
 * `dream.listUnprocessed` Exec builtin.
 *
 * Surfaces unprocessed thread_summaries rows plus memories_extensions/* files
 * whose per-file mtimes are newer than the persisted Dream watermark data.
 * Read by the Dream agent (and any future tooling that wants to inspect the
 * queue).
 */

import { dreamList } from "../../../memory/dream-core.js";
import type { ThreadSummariesStore } from "../../../memory/thread-summaries-store.js";
import type { ExecToolDefinition } from "../registry.js";

const SCHEMA = {
  type: "object",
  properties: {
    sinceWatermark: {
      type: "number",
      description:
        "Optional Unix epoch ms override for thread_summaries only.",
    },
    limit: {
      type: "number",
      description: "Cap on rows returned (default 50, max 500).",
    },
  },
} as const;

export type DreamInputsBuiltinOptions = {
  stellaHome: string;
  threadSummariesStore: ThreadSummariesStore;
  agentTypes?: readonly string[];
};

export const createDreamInputsBuiltin = (
  options: DreamInputsBuiltinOptions,
): ExecToolDefinition => ({
  name: "dream.listUnprocessed",
  description:
    "Return unprocessed thread_summaries rows and memories_extensions/* file paths newer than the persisted per-file watermark data.",
  ...(options.agentTypes ? { agentTypes: options.agentTypes } : {}),
  inputSchema: SCHEMA,
  handler: async (rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const sinceWatermark =
      typeof args.sinceWatermark === "number" ? args.sinceWatermark : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return dreamList({
      stellaHome: options.stellaHome,
      store: options.threadSummariesStore,
      ...(sinceWatermark !== undefined ? { sinceWatermark } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  },
});
