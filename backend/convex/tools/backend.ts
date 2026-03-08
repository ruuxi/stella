import { tool, ToolSet } from "ai";
import { z } from "zod";
import type { ActionCtx } from "../_generated/server";
import { generateTextWithFailover } from "../agent/model_execution";
import { resolveFallbackConfig, resolveModelConfig } from "../agent/model_resolver";
import type { ToolOptions } from "./types";

const MAX_WEB_SEARCH_RESULTS = 6;
const MAX_WEB_SEARCH_TEXT_CHARS = 1000;
const MAX_WEB_SEARCH_SNIPPET_CHARS = 300;

/**
 * Wrap external content with safety markers so the LLM knows it's untrusted.
 */
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
  html?: string;
};

const sanitizeGeneratedHtml = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:html|tsx?)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

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

const generateNewsHtml = async (
  ctx: Pick<ActionCtx, "runQuery">,
  options: {
    ownerId?: string;
    query: string;
    results: SearchHit[];
  },
): Promise<string | undefined> => {
  if (options.results.length === 0) return undefined;

  const resultsText = options.results
    .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
    .join("\n\n");

  const prompt =
    `Generate a visual HTML news summary for the search query: "${options.query}"\n\n` +
    `Search results:\n${resultsText}\n\n` +
    "Output self-contained HTML that visually presents these results as a news feed. " +
    "Use semantic HTML (h2, h3, p, a, small). " +
    "For colors use var(--foreground) and var(--background). " +
    "Keep it concise and scannable. No scripts. No markdown fences.";

  const resolvedConfig = await resolveModelConfig(ctx, "news_generate", options.ownerId);
  const fallbackConfig = await resolveFallbackConfig(ctx, "news_generate", options.ownerId);
  const result = await generateTextWithFailover({
    resolvedConfig,
    fallbackConfig,
    sharedArgs: {
      system: "You generate clean, self-contained HTML for a news panel. No markdown fences. No explanation. Just HTML.",
      messages: [{ role: "user", content: prompt }],
    },
  });

  const html = sanitizeGeneratedHtml(result.text ?? "");
  return html || undefined;
};

export const executeWebSearch = async (
  ctx: Pick<ActionCtx, "runQuery">,
  queryInput: string,
  options: {
    ownerId?: string;
    includeHtml?: boolean;
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
        contents: {
          text: { maxCharacters: MAX_WEB_SEARCH_TEXT_CHARS },
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
        text?: string;
      }>;
    };

    const results: SearchHit[] = (data.results ?? []).map((result) => ({
      title: (result.title ?? "(no title)").trim(),
      url: (result.url ?? "").trim(),
      snippet: (result.text ?? "").trim().slice(0, MAX_WEB_SEARCH_SNIPPET_CHARS),
    }));

    const searchResult: WebSearchResponse = {
      text: formatWebSearchText(query, results),
      results,
    };

    if (options.includeHtml && results.length > 0) {
      try {
        searchResult.html = await generateNewsHtml(ctx, {
          ownerId: options.ownerId,
          query,
          results,
        });
      } catch (error) {
        console.warn(
          `[web-search] News HTML generation failed for "${query}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return searchResult;
  } catch (error) {
    return {
      text: `WebSearch failed: ${(error as Error).message}`,
      results: [],
    };
  }
};

export const createBackendTools = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
  const stripHtml = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const truncateText = (value: string, max = 30_000) =>
    value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;

  return {
    WebSearch: tool({
      description:
        "Search the web for current information.\n\n" +
        "Usage:\n" +
        "- Returns up to 6 results with title, URL, and text snippet.\n" +
        "- Use for questions requiring up-to-date information beyond training data.\n" +
        "- query should be a natural language search phrase.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Search query (natural language)"),
      }),
      execute: async (args) => {
        const result = await executeWebSearch(ctx, args.query, {
          ownerId: options.ownerId,
          includeHtml: false,
        });
        return result.text;
      },
    }),
    WebFetch: tool({
      description:
        "Fetch and read content from a URL.\n\n" +
        "Usage:\n" +
        "- Fetches the page content, strips HTML tags, and returns plain text.\n" +
        "- HTTP URLs are auto-upgraded to HTTPS.\n" +
        "- prompt describes what information you want to extract - it's returned alongside the content for context.\n" +
        "- Content is truncated to 15,000 characters.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch (HTTP auto-upgrades to HTTPS)"),
        prompt: z.string().describe("What information you want from this page"),
      }),
      execute: async (args) => {
        const secureUrl = args.url.replace(/^http:/, "https:");
        try {
          const response = await fetch(secureUrl, {
            headers: { "User-Agent": "StellaBackend/1.0" },
          });
          if (!response.ok) {
            return `Failed to fetch (${response.status} ${response.statusText})`;
          }
          const text = await response.text();
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("text/html") ? stripHtml(text) : text;
          return wrapExternalContent(
            `Content from ${secureUrl}\nPrompt: ${args.prompt}\n\n${truncateText(body, 15_000)}`,
            secureUrl,
          );
        } catch (error) {
          return `Error fetching URL: ${(error as Error).message}`;
        }
      },
    }),
    NoResponse: tool({
      description:
        "Signal that you have nothing to say to the user right now. " +
        "Call this instead of generating a message when a system event, task result, or heartbeat check " +
        "does not warrant a visible response. Do NOT call this for user messages - always reply to users.",
      inputSchema: z.object({}),
      execute: async () => {
        return "__NO_RESPONSE__";
      },
    }),
  };
};
