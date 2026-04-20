import { TOOL_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import type { MemoryStore, MemoryTarget } from "../memory/memory-store.js";
import { localNoResponse, localWebFetch } from "./local-tool-overrides.js";

export type LocalToolStore = {
  memoryStore: MemoryStore;
};

/**
 * Optional Explore handler. When present, the General agent can call the
 * `Explore` tool to launch an additional scout pass over `state/` mid-task.
 * Returns the wrapped `<explore_findings>...</explore_findings>` block as a
 * string. Always returns; never throws (failures yield the unavailable block).
 */
export type LocalExploreHandler = (args: {
  conversationId: string;
  question: string;
  signal?: AbortSignal;
}) => Promise<string>;

const isMemoryTarget = (value: unknown): value is MemoryTarget =>
  value === "memory" || value === "user";

const isMemoryAction = (
  value: unknown,
): value is "add" | "replace" | "remove" =>
  value === "add" || value === "replace" || value === "remove";

export type LocalToolDeps = {
  conversationId: string;
  webSearch?: (
    query: string,
    options?: { category?: string },
  ) => Promise<{ text: string }>;
  store?: LocalToolStore | null;
  explore?: LocalExploreHandler;
  signal?: AbortSignal;
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

  if (toolName === TOOL_IDS.MEMORY) {
    if (!deps.store) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "Memory store not available.",
        }),
      };
    }
    const action = isMemoryAction(args.action) ? args.action : null;
    const target = isMemoryTarget(args.target) ? args.target : null;
    if (!action) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "action must be one of: add, replace, remove.",
        }),
      };
    }
    if (!target) {
      return {
        handled: true,
        text: JSON.stringify({
          success: false,
          error: "target must be one of: memory, user.",
        }),
      };
    }
    const content = typeof args.content === "string" ? args.content : "";
    const oldText = typeof args.oldText === "string" ? args.oldText : "";

    let result;
    if (action === "add") {
      result = deps.store.memoryStore.add(target, content);
    } else if (action === "replace") {
      result = deps.store.memoryStore.replace(target, oldText, content);
    } else {
      result = deps.store.memoryStore.remove(target, oldText);
    }
    return { handled: true, text: JSON.stringify(result) };
  }

  if (toolName === TOOL_IDS.EXPLORE) {
    if (!deps.explore) {
      return {
        handled: true,
        text: `<explore_findings status="unavailable">{"relevant": [], "maybe": [], "nothing_found_for": []}</explore_findings>`,
      };
    }
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) {
      return {
        handled: true,
        text: `<explore_findings status="unavailable">{"relevant": [], "maybe": [], "nothing_found_for": ["question was empty"]}</explore_findings>`,
      };
    }
    const text = await deps.explore({
      conversationId: deps.conversationId,
      question,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return { handled: true, text };
  }

  return { handled: false };
}
