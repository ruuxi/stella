/**
 * Web tools: WebFetch, WebSearch handlers.
 */
import { stripHtml, truncate } from "./tools-utils.js";
export const handleWebFetch = async (args) => {
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
            result: `Content from ${secureUrl}\nPrompt: ${prompt}\n\n${truncate(body, 15000)}`,
        };
    }
    catch (error) {
        return { error: `Error fetching URL: ${error.message}` };
    }
};
const flattenTopics = (topics) => {
    const results = [];
    for (const topic of topics) {
        if (!topic || typeof topic !== "object")
            continue;
        const record = topic;
        if (record.Text && record.FirstURL) {
            results.push({ title: record.Text, url: record.FirstURL });
        }
        if (record.Topics) {
            results.push(...flattenTopics(record.Topics));
        }
    }
    return results;
};
export const handleWebSearch = async (args) => {
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
        const data = (await response.json());
        const items = [];
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
        const unique = Array.from(new Map(items.map((item) => [item.url, item])).values()).slice(0, 6);
        if (unique.length === 0) {
            return { result: `No web results found for "${query}".` };
        }
        const formatted = unique
            .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}`)
            .join("\n");
        return {
            result: `Web search results for "${query}":\n\n${formatted}`,
        };
    }
    catch (error) {
        return { error: `Search failed: ${error.message}` };
    }
};
