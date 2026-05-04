/**
 * `web` tool — unified web search + fetch.
 *
 * Pass exactly one of `query` or `url`. Search routes through the optionally
 * injected `webSearch` capability; fetch always uses the local readable-text
 * extractor (`localWebFetch`). Search results flow back as plain text /
 * structured `details.results` for the model to summarize — the chat
 * surface never auto-renders them.
 *
 * One file owns everything for this tool: name, description, parameters,
 * prompt snippet, and the executable handler. Agents don't reach for tool
 * names through a central catalog — the host imports this file and the
 * registry exposes the resulting `ToolDefinition` directly.
 */

import { localWebFetch } from "../local-tool-overrides.js";
import type { ToolDefinition } from "../types.js";

export type WebToolOptions = {
  webSearch?: (
    query: string,
    options?: { category?: string },
  ) => Promise<{
    text: string;
    results?: Array<{ title: string; url: string; snippet: string }>;
  }>;
};

const WEB_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  description:
    "Either search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url.",
  properties: {
    query: {
      type: "string",
      description:
        "Web search query. Returns ranked results with title, URL, and snippet.",
    },
    url: {
      type: "string",
      description:
        "URL to fetch. Returns the page rendered as readable text with HTML stripped.",
    },
    category: {
      type: "string",
      description:
        "Optional Exa category hint when using query (e.g. 'news', 'company', 'research_paper').",
    },
    prompt: {
      type: "string",
      description:
        "Optional follow-up prompt used by the local fetcher to extract just the relevant slice of a long page.",
    },
  },
};

export const createWebTool = (options: WebToolOptions = {}): ToolDefinition => ({
  name: "web",
  description:
    "Search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url. Use this for facts that change over time, recent news, current documentation, or any specific page you need to read.",
  promptSnippet: "Search the web or fetch a URL",
  parameters: WEB_TOOL_PARAMETERS,
  execute: async (args) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const prompt =
      typeof args.prompt === "string"
        ? args.prompt.trim() || undefined
        : undefined;

    if (!query && !url) {
      return { error: "Either query or url is required." };
    }
    if (query && url) {
      return { error: "Pass either query or url, not both." };
    }

    if (query) {
      if (!options.webSearch) {
        return { error: "web search is not available on this device." };
      }
      const category =
        typeof args.category === "string"
          ? args.category.trim() || undefined
          : undefined;
      try {
        const result = await options.webSearch(query, {
          ...(category ? { category } : {}),
        });
        return {
          result: result.text || "No results found.",
          details: {
            mode: "search",
            query,
            ...(Array.isArray(result.results) ? { results: result.results } : {}),
          },
        };
      } catch (error) {
        return { error: `web search failed: ${(error as Error).message}` };
      }
    }

    const text = await localWebFetch({ url, ...(prompt ? { prompt } : {}) });
    return {
      result: text,
      details: { mode: "fetch", url, ...(prompt ? { prompt } : {}) },
    };
  },
});
