import { action } from "./_generated/server";
import { requireUserId } from "./auth";
import { v } from "convex/values";

const MAX_RESULTS = 6;
const MAX_SNIPPET_CHARS = 300;

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

const wrapExternalContent = (content: string, source: string): string =>
  `[External Content - Untrusted Source: ${source}]\n${content}\n[End External Content]`;

export const search = action({
  args: {
    query: v.string(),
  },
  returns: v.object({
    text: v.string(),
    results: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        snippet: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await requireUserId(ctx);

    const query = args.query.trim();
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
          numResults: MAX_RESULTS,
          contents: {
            text: { maxCharacters: 1000 },
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
        snippet: (result.text ?? "").trim().slice(0, MAX_SNIPPET_CHARS),
      }));

      if (results.length === 0) {
        return {
          text: `No web results found for "${query}".`,
          results: [],
        };
      }

      const formatted = results
        .map((result, index) => {
          const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`];
          if (result.snippet) parts.push(`   ${result.snippet}`);
          return parts.join("\n");
        })
        .join("\n\n");

      return {
        text: wrapExternalContent(
          `Web search results for "${query}":\n\n${formatted}`,
          `web search: ${query}`,
        ),
        results,
      };
    } catch (error) {
      return {
        text: `WebSearch failed: ${(error as Error).message}`,
        results: [],
      };
    }
  },
});
