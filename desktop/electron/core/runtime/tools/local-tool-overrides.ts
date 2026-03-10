/**
 * Local tool implementations for tools that don't need the server.
 *
 * These replace the backend passthrough (`callBackendTool`) for tools
 * that can execute entirely in the Electron process:
 * - WebFetch: direct fetch() + HTML-to-text
 * - ActivateSkill: read from desktop/.stella/skills/ on disk
 * - NoResponse: immediate return
 */

import fs from "fs";
import path from "path";

const MAX_FETCH_BODY_CHARS = 80_000;
const FETCH_TIMEOUT_MS = 30_000;

// ── WebFetch ──────────────────────────────────────────────────────────────

/**
 * Minimal HTML-to-text conversion. Strips tags and decodes common entities.
 * No external dependency needed for this basic extraction.
 */
const htmlToText = (html: string): string => {
  // Remove script/style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Replace <br>, <p>, <div>, <li> with newlines
  text = text.replace(/<(?:br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
};

export const localWebFetch = async (args: {
  url: string;
  prompt?: string;
}): Promise<string> => {
  const { url } = args;
  if (!url) return "Error: URL is required.";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Stella/1.0 (Desktop Assistant)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text();

    let text: string;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      text = htmlToText(rawBody);
    } else {
      text = rawBody;
    }

    if (text.length > MAX_FETCH_BODY_CHARS) {
      text = text.slice(0, MAX_FETCH_BODY_CHARS) + "\n\n[Content truncated]";
    }

    if (!text.trim()) {
      return "The page returned no readable text content.";
    }

    return text;
  } catch (error) {
    const msg = (error as Error).message ?? "Unknown error";
    if (msg.includes("abort")) {
      return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return `Error fetching URL: ${msg}`;
  }
};

// ── ActivateSkill ─────────────────────────────────────────────────────────

export const localActivateSkill = async (args: {
  skillId: string;
  stellaHome: string;
}): Promise<string> => {
  const { skillId, stellaHome } = args;
  if (!skillId) return "Error: skillId is required.";

  // Reject path traversal attempts
  if (/[/\\]|\.\./.test(skillId)) {
    return "Error: invalid skillId.";
  }

  const skillDir = path.join(stellaHome, "skills", skillId);
  const skillFile = path.join(skillDir, "SKILL.md");

  try {
    const content = fs.readFileSync(skillFile, "utf-8");
    if (!content.trim()) {
      return `Skill '${skillId}' found but has no content.`;
    }
    return content;
  } catch {
    // Try alternate paths
    const altFile = path.join(stellaHome, "skills", `${skillId}.md`);
    try {
      return fs.readFileSync(altFile, "utf-8");
    } catch {
      // List available skills so the agent knows what exists
      const skillsDir = path.join(stellaHome, "skills");
      let available: string[] = [];
      try {
        available = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        // ignore
      }
      const listing = available.length > 0
        ? `Available skills: ${available.join(", ")}`
        : "No skills are currently installed.";
      return `Skill '${skillId}' not found. ${listing}`;
    }
  }
};

// ── NoResponse ────────────────────────────────────────────────────────────

export const localNoResponse = async (): Promise<string> => {
  return "";
};
