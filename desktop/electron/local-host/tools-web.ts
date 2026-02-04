/**
 * Web tools: WebFetch, WebSearch handlers.
 */

import type { ToolResult } from "./tools-types.js";
import { stripHtml, truncate } from "./tools-utils.js";

export const handleWebFetch = async (args: Record<string, unknown>): Promise<ToolResult> => {
  const url = String(args.url ?? "");
  const prompt = String(args.prompt ?? "");
  const secureUrl = url.replace(/^http:/, "https:");
  try {
    const response = await fetch(secureUrl, {
      headers: {
        "User-Agent": "StellaLocalHost/1.0",
      },
    });
    if (!response.ok) {
      return { error: `Failed to fetch (${response.status} ${response.statusText})` };
    }
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("text/html") ? stripHtml(text) : text;
    return {
      result: `Content from ${secureUrl}\nPrompt: ${prompt}\n\n${truncate(body, 15_000)}`,
    };
  } catch (error) {
    return { error: `Error fetching URL: ${(error as Error).message}` };
  }
};

const flattenTopics = (topics: unknown[]): Array<{ title: string; url: string }> => {
  const results: Array<{ title: string; url: string }> = [];
  for (const topic of topics) {
    if (!topic || typeof topic !== "object") continue;
    const record = topic as {
      Text?: string;
      FirstURL?: string;
      Topics?: unknown[];
    };
    if (record.Text && record.FirstURL) {
      results.push({ title: record.Text, url: record.FirstURL });
    }
    if (record.Topics) {
      results.push(...flattenTopics(record.Topics));
    }
  }
  return results;
};

export const handleWebSearch = async (args: Record<string, unknown>): Promise<ToolResult> => {
  const query = String(args.query ?? "");
  try {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    const response = await fetch(url);
    if (!response.ok) {
      return { error: `Search failed (${response.status})` };
    }
    const data = (await response.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
      RelatedTopics?: unknown[];
    };

    const items: Array<{ title: string; url: string }> = [];
    if (data.AbstractText && data.AbstractURL) {
      items.push({ title: data.AbstractText, url: data.AbstractURL });
    }
    if (Array.isArray(data.Results)) {
      for (const result of data.Results) {
        if (result.Text && result.FirstURL) {
          items.push({ title: result.Text, url: result.FirstURL });
        }
      }
    }
    if (Array.isArray(data.RelatedTopics)) {
      items.push(...flattenTopics(data.RelatedTopics));
    }

    const unique = Array.from(
      new Map(items.map((item) => [item.url, item])).values(),
    ).slice(0, 6);

    if (unique.length === 0) {
      return { result: `No web results found for "${query}".` };
    }

    const formatted = unique
      .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}`)
      .join("\n");

    return {
      result: `Web search results for "${query}":\n\n${formatted}`,
    };
  } catch (error) {
    return { error: `Search failed: ${(error as Error).message}` };
  }
};
