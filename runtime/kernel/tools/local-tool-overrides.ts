/**
 * Local tool implementations for tools that don't need the server.
 *
 * These replace the backend passthrough (`callBackendTool`) for tools
 * that can execute entirely in the Electron process:
 * - WebFetch: direct fetch() + HTML-to-text
 * - NoResponse: immediate return
 */

import { normalizeSafeExternalUrl } from "./network-guards.js";
import { containsSecretLikeToken, sanitizeToolVisibleText } from "./safety.js";

export const MAX_FETCH_BODY_CHARS = 24_000;
export const MAX_PROMPT_FETCH_BODY_CHARS = 16_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_REDIRECTS = 5;
const PROMPT_CONTEXT_LINES = 5;
const PROMPT_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "check",
  "current",
  "extract",
  "from",
  "give",
  "just",
  "latest",
  "notes",
  "official",
  "page",
  "release",
  "relevant",
  "stable",
  "that",
  "this",
  "what",
  "with",
]);

// WebFetch

/**
 * Minimal HTML-to-text conversion. Strips tags and decodes common entities.
 * No external dependency needed for this basic extraction.
 */
const htmlToText = (html: string): string => {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<(?:br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
};

const promptSearchTerms = (prompt: string): string[] =>
  Array.from(
    new Set(
      (prompt.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).filter(
        (term) =>
          !PROMPT_STOP_WORDS.has(term) && (term.length >= 3 || /\d/.test(term)),
      ),
    ),
  );

const boundedText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[Content truncated]\n\n";
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available * 0.7);
  const tailChars = Math.floor(available - headChars);
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
};

/**
 * Select prompt-relevant windows from a long page before it becomes model
 * context. The extraction is deterministic and intentionally conservative:
 * when no useful term matches, the normal bounded head/tail projection wins.
 */
export const extractRelevantWebText = (
  text: string,
  prompt?: string,
): string => {
  const normalizedPrompt = prompt?.trim();
  if (!normalizedPrompt) return boundedText(text, MAX_FETCH_BODY_CHARS);

  const terms = promptSearchTerms(normalizedPrompt);
  const lines = text.split("\n");
  const scoredLines = lines
    .map((line, index) => {
      const lower = line.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (lower.includes(term) ? term.length : 0),
        0,
      );
      return { index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );

  if (scoredLines.length === 0) {
    return boundedText(text, MAX_PROMPT_FETCH_BODY_CHARS);
  }

  const selected = new Set<number>();
  for (const match of scoredLines) {
    for (
      let index = Math.max(0, match.index - PROMPT_CONTEXT_LINES);
      index <= Math.min(lines.length - 1, match.index + PROMPT_CONTEXT_LINES);
      index += 1
    ) {
      selected.add(index);
    }
    const selectedChars = Array.from(selected).reduce(
      (sum, index) => sum + (lines[index]?.length ?? 0) + 1,
      0,
    );
    if (selectedChars >= MAX_PROMPT_FETCH_BODY_CHARS) break;
  }

  const excerpts: string[] = [];
  let previousIndex = -2;
  for (const index of Array.from(selected).sort(
    (left, right) => left - right,
  )) {
    if (index > previousIndex + 1 && excerpts.length > 0) excerpts.push("[…]");
    excerpts.push(lines[index] ?? "");
    previousIndex = index;
  }

  return boundedText(
    `[Relevant excerpts for: ${normalizedPrompt}]\n\n${excerpts.join("\n")}`,
    MAX_PROMPT_FETCH_BODY_CHARS,
  );
};

export const localWebFetch = async (args: {
  url: string;
  prompt?: string;
}): Promise<string> => {
  if (!args.url) return "Error: URL is required.";
  if (containsSecretLikeToken(args.url)) {
    return "Error: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let targetUrl = await normalizeSafeExternalUrl(args.url);

    let response: Response | null = null;
    for (
      let redirectCount = 0;
      redirectCount <= MAX_FETCH_REDIRECTS;
      redirectCount += 1
    ) {
      response = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Stella/1.0 (Desktop Assistant)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        targetUrl = await normalizeSafeExternalUrl(
          new URL(location, targetUrl).toString(),
        );
        continue;
      }

      break;
    }
    if (!response) {
      return "Error: No response received.";
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      return `Error: Too many redirects (limit ${MAX_FETCH_REDIRECTS})`;
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text();

    let text: string;
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
      text = htmlToText(rawBody);
    } else {
      text = rawBody;
    }

    text = extractRelevantWebText(text, args.prompt);

    if (!text.trim()) {
      return "The page returned no readable text content.";
    }

    return sanitizeToolVisibleText(text);
  } catch (error) {
    const msg = (error as Error).message ?? "Unknown error";
    if (msg.includes("abort")) {
      return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return `Error fetching URL: ${sanitizeToolVisibleText(msg)}`;
  } finally {
    clearTimeout(timeout);
  }
};

// NoResponse

export const localNoResponse = async (): Promise<string> => {
  return "";
};
