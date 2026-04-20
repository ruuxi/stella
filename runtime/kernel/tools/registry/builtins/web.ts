/**
 * Web tools for the Exec registry: `web_fetch` and (when wired) `web_search`.
 *
 * `web_search` requires an Exa client supplied at host construction; if none
 * is provided, the tool throws a clear error.
 */

import { localWebFetch } from "../../local-tool-overrides.js";
import type { ExecToolDefinition } from "../registry.js";

const WEB_FETCH_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch (HTTP auto-upgrades to HTTPS)." },
    prompt: {
      type: "string",
      description: "Optional context describing what info to extract.",
    },
  },
  required: ["url"],
} as const;

const WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language query. Write descriptively, not as keywords.",
    },
    category: {
      type: "string",
      enum: ["company", "people", "research paper"],
      description:
        "Optional Exa category. Omit for news/sports/general facts.",
    },
  },
  required: ["query"],
} as const;

export type WebSearchHandler = (
  query: string,
  options?: { category?: string },
) => Promise<{ text: string }>;

export type WebBuiltinOptions = {
  webSearch?: WebSearchHandler;
};

export const createWebBuiltins = (
  options: WebBuiltinOptions,
): ExecToolDefinition[] => {
  const tools: ExecToolDefinition[] = [
    {
      name: "web_fetch",
      description:
        "Fetch a URL and return readable text (HTML stripped). Useful for extracting plain content from articles, docs, or APIs that respond with HTML.",
      inputSchema: WEB_FETCH_SCHEMA,
      handler: async (rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        const url = typeof args.url === "string" ? args.url : "";
        if (!url) throw new Error("url is required.");
        const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
        const text = await localWebFetch({
          url,
          ...(prompt ? { prompt } : {}),
        });
        return { url, text };
      },
    },
  ];
  if (options.webSearch) {
    tools.push({
      name: "web_search",
      description:
        "Search the web (via Exa) for current information. Returns natural-language results with titles, urls, and excerpts.",
      inputSchema: WEB_SEARCH_SCHEMA,
      handler: async (rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        const query = typeof args.query === "string" ? args.query : "";
        if (!query) throw new Error("query is required.");
        const category =
          typeof args.category === "string" ? args.category : undefined;
        const result = await options.webSearch!(
          query,
          category ? { category } : undefined,
        );
        return { query, text: result.text };
      },
    });
  }
  return tools;
};
