import { TOOL_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import { localNoResponse, localWebFetch } from "./local-tool-overrides.js";

export type LocalToolStore = {
  saveMemory: (args: {
    conversationId: string;
    content: string;
    tags?: string[];
  }) => void;
  recallMemories: (args: {
    query: string;
    limit?: number;
  }) => Array<{ content: string }>;
};

export type LocalToolDeps = {
  conversationId: string;
  webSearch?: (
    query: string,
    options?: { category?: string },
  ) => Promise<{ text: string }>;
  store?: LocalToolStore | null;
};

type DispatchResult =
  | { handled: true; text: string }
  | { handled: false };

/**
 * Dispatch tools that execute locally (no backend round-trip).
 * Shared between the agent tool-adapter pipeline and the voice service.
 */
export async function dispatchLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  deps: LocalToolDeps,
): Promise<DispatchResult> {
  if (toolName === TOOL_IDS.WEB_SEARCH) {
    if (!deps.webSearch) {
      return { handled: true, text: "WebSearch is not available." };
    }
    const query = typeof args.query === "string" ? args.query : "";
    const category =
      typeof args.category === "string" ? args.category : undefined;
    const result = await deps.webSearch(query, { category });
    return { handled: true, text: result.text || "No results found." };
  }

  if (toolName === TOOL_IDS.WEB_FETCH) {
    const url = typeof args.url === "string" ? args.url : "";
    const prompt =
      typeof args.prompt === "string" ? args.prompt : undefined;
    const text = await localWebFetch({ url, prompt });
    return { handled: true, text };
  }

  if (toolName === TOOL_IDS.NO_RESPONSE) {
    const text = await localNoResponse();
    return { handled: true, text };
  }

  if (toolName === TOOL_IDS.SAVE_MEMORY) {
    if (!deps.store) {
      return { handled: true, text: "Runtime store not available." };
    }
    const content =
      typeof args.content === "string" ? args.content : "";
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === "string")
      : undefined;
    deps.store.saveMemory({
      conversationId: deps.conversationId,
      content,
      ...(tags && tags.length > 0 ? { tags } : {}),
    });
    return {
      handled: true,
      text: content.trim() ? "Saved memory entry." : "No memory content provided.",
    };
  }

  if (toolName === TOOL_IDS.RECALL_MEMORIES) {
    if (!deps.store) {
      return { handled: true, text: "Runtime store not available." };
    }
    const query = typeof args.query === "string" ? args.query : "";
    const limit =
      typeof args.limit === "number" ? args.limit : undefined;
    const rows = deps.store.recallMemories({
      query,
      ...(limit ? { limit } : {}),
    });
    return {
      handled: true,
      text:
        rows.length > 0
          ? rows.map((row, i) => `${i + 1}. ${row.content}`).join("\n")
          : "No matching memories found.",
    };
  }

  return { handled: false };
}
