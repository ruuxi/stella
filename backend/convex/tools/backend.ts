import type { ActionCtx } from "../_generated/server";
import { BACKEND_TOOL_IDS } from "../lib/agent_constants";
import { truncateWithNotice } from "../lib/text_utils";
import { normalizeSafeExternalUrl } from "../lib/url_security";
import type { BackendToolSet, ToolOptions } from "./types";

const MAX_WEB_SEARCH_RESULTS = 6;
const MAX_WEB_SEARCH_HIGHLIGHT_CHARS = 400;
const MAX_WEB_SEARCH_SNIPPET_CHARS = 300;
const MAX_WEB_FETCH_REDIRECTS = 5;

const wrapExternalContent = (content: string, source: string): string =>
  `[External Content - Untrusted Source: ${source}]\n${content}\n[End External Content]`;

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResponse = {
  text: string;
  results: SearchHit[];
};

const formatWebSearchText = (query: string, results: SearchHit[]): string => {
  if (results.length === 0) {
    return `No web results found for "${query}".`;
  }

  const formatted = results
    .map((result, index) => {
      const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`];
      if (result.snippet) parts.push(`   ${result.snippet}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return wrapExternalContent(
    `Web search results for "${query}":\n\n${formatted}`,
    `web search: ${query}`,
  );
};

export const executeWebSearch = async (
  ctx: Pick<ActionCtx, "runQuery">,
  queryInput: string,
  options: {
    ownerId?: string;
    category?: string;
  } = {},
): Promise<WebSearchResponse> => {
  const query = queryInput.trim();
  if (!query) {
    return {
      text: "WebSearch failed: query is required.",
      results: [],
    };
  }

  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return {
      text: "WebSearch is not configured (missing EXA_API_KEY).",
      results: [],
    };
  }

  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: MAX_WEB_SEARCH_RESULTS,
        ...(options.category ? { category: options.category } : {}),
        contents: {
          highlights: { maxCharacters: MAX_WEB_SEARCH_HIGHLIGHT_CHARS },
        },
      }),
    });

    if (!response.ok) {
      return {
        text: `WebSearch failed (${response.status}): ${await response.text()}`,
        results: [],
      };
    }

    const data = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        highlights?: string[];
        text?: string;
      }>;
    };

    const results: SearchHit[] = (data.results ?? []).map((result) => {
      const snippet = result.highlights?.length
        ? result.highlights.join(" ... ")
        : (result.text ?? "");
      return {
        title: (result.title ?? "(no title)").trim(),
        url: (result.url ?? "").trim(),
        snippet: snippet.trim().slice(0, MAX_WEB_SEARCH_SNIPPET_CHARS),
      };
    });

    return {
      text: formatWebSearchText(query, results),
      results,
    };
  } catch (error) {
    return {
      text: `WebSearch failed: ${(error as Error).message}`,
      results: [],
    };
  }
};

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 2,
      description:
        "Natural language search query - write descriptively, not as keywords",
    },
    category: {
      type: "string",
      enum: ["company", "people", "research paper"],
      description: "Optional filter. Most queries should omit this.",
    },
  },
  required: ["query"],
} as const;

const WEB_FETCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      description: "URL to fetch (HTTP auto-upgrades to HTTPS)",
    },
    prompt: {
      type: "string",
      description: "What information you want from this page",
    },
  },
  required: ["url", "prompt"],
} as const;

const EMPTY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const createBackendTools = (
  ctx: ActionCtx,
  options: ToolOptions,
): BackendToolSet => {
  const stripHtml = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  return {
    [BACKEND_TOOL_IDS.WEB_SEARCH]: {
      name: BACKEND_TOOL_IDS.WEB_SEARCH,
      description:
        "Search the web via Exa for current information.\n\n" +
        "Use natural language queries, not keywords (e.g. 'Tesla current stock performance' not 'TSLA stock price').\n" +
        "Returns up to 6 results with title, URL, and highlighted excerpts.\n\n" +
        "CATEGORIES - use sparingly, most queries should omit:\n" +
        "- 'company': only for company research.\n" +
        "- 'people': only for non-public figures. Never for public figures or news about someone.\n" +
        "- 'research paper': only for academic papers.\n" +
        "For news, sports, general facts - do NOT set a category.",
      parameters: WEB_SEARCH_PARAMETERS,
      execute: async (args) => {
        const result = await executeWebSearch(ctx, String(args.query ?? ""), {
          ownerId: options.ownerId,
          category: typeof args.category === "string" ? args.category : undefined,
        });
        return result.text;
      },
    },
    [BACKEND_TOOL_IDS.WEB_FETCH]: {
      name: BACKEND_TOOL_IDS.WEB_FETCH,
      description:
        "Fetch and read content from a URL.\n\n" +
        "Usage:\n" +
        "- Fetches the page content, strips HTML tags, and returns plain text.\n" +
        "- HTTP URLs are auto-upgraded to HTTPS.\n" +
        "- prompt describes what information you want to extract - it's returned alongside the content for context.\n" +
        "- Content is truncated to 15,000 characters.",
      parameters: WEB_FETCH_PARAMETERS,
      execute: async (args) => {
        try {
          let secureUrl = normalizeSafeExternalUrl(String(args.url ?? ""));
          let response: Response | null = null;
          for (
            let redirectCount = 0;
            redirectCount <= MAX_WEB_FETCH_REDIRECTS;
            redirectCount += 1
          ) {
            response = await fetch(secureUrl, {
              redirect: "manual",
              headers: { "User-Agent": "StellaBackend/1.0" },
            });

            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
              secureUrl = normalizeSafeExternalUrl(
                new URL(location, secureUrl).toString(),
              );
              continue;
            }
            break;
          }

          if (!response) {
            return "Failed to fetch (no response)";
          }
          if (
            response.status >= 300
            && response.status < 400
            && response.headers.get("location")
          ) {
            return `Failed to fetch (too many redirects, limit ${MAX_WEB_FETCH_REDIRECTS})`;
          }
          if (!response.ok) {
            return `Failed to fetch (${response.status} ${response.statusText})`;
          }

          const text = await response.text();
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("text/html")
            ? stripHtml(text)
            : text;

          return wrapExternalContent(
            `Content from ${secureUrl}\nPrompt: ${String(args.prompt ?? "")}\n\n${truncateWithNotice(body, 15_000)}`,
            secureUrl,
          );
        } catch (error) {
          return `Error fetching URL: ${(error as Error).message}`;
        }
      },
    },
    [BACKEND_TOOL_IDS.NO_RESPONSE]: {
      name: BACKEND_TOOL_IDS.NO_RESPONSE,
      description:
        "Signal that you have nothing to say to the user right now. " +
        "Call this instead of generating a message when a system event, task result, or heartbeat check " +
        "does not warrant a visible response. Do NOT call this for user messages - always reply to users.",
      parameters: EMPTY_PARAMETERS,
      execute: async () => "__NO_RESPONSE__",
    },
  };
};
