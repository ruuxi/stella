/**
 * Local tool implementations for tools that don't need the server.
 *
 * These replace the backend passthrough (`callBackendTool`) for tools
 * that can execute entirely in the Electron process:
 * - WebFetch: direct fetch() + HTML-to-text
 * - ActivateSkill: read from install-root `.stella/skills/` on disk
 * - NoResponse: immediate return
 */

import fs from "fs";
import path from "path";
import { normalizeSafeExternalUrl } from "./network-guards.js";

const MAX_FETCH_BODY_CHARS = 80_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_REDIRECTS = 5;

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
  if (!args.url) return "Error: URL is required.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let targetUrl = await normalizeSafeExternalUrl(args.url);

    let response: Response | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_FETCH_REDIRECTS; redirectCount += 1) {
      response = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Stella/1.0 (Desktop Assistant)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
      });

      const location = response.headers.get("location");
      if (
        response.status >= 300 &&
        response.status < 400 &&
        location
      ) {
        targetUrl = await normalizeSafeExternalUrl(new URL(location, targetUrl).toString());
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
  } finally {
    clearTimeout(timeout);
  }
};

// ── ActivateSkill ─────────────────────────────────────────────────────────

const SKILL_DIRS = ["skills", "core-skills"] as const;

const tryReadSkillFile = (
  stellaHome: string,
  subdir: string,
  relativePath: string,
): string | null => {
  const skillsRoot = path.join(stellaHome, subdir);
  const filePath = path.join(skillsRoot, relativePath);
  try {
    const resolvedRoot = fs.realpathSync(skillsRoot);
    const resolvedFile = fs.realpathSync(filePath);
    const rel = path.relative(resolvedRoot, resolvedFile);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const content = fs.readFileSync(resolvedFile, "utf-8");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
};

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

  // Search user skills first, then core skills
  for (const subdir of SKILL_DIRS) {
    const content =
      tryReadSkillFile(stellaHome, subdir, path.join(skillId, "SKILL.md")) ??
      tryReadSkillFile(stellaHome, subdir, `${skillId}.md`);
    if (content) return content;
  }

  // Not found — list available skills from both directories
  const available: string[] = [];
  for (const subdir of SKILL_DIRS) {
    try {
      const entries = fs.readdirSync(path.join(stellaHome, subdir), { withFileTypes: true });
      for (const d of entries) {
        if (d.isDirectory() && !available.includes(d.name)) {
          available.push(d.name);
        }
      }
    } catch {
      // ignore
    }
  }
  const listing = available.length > 0
    ? `Available skills: ${available.join(", ")}`
    : "No skills are currently installed.";
  return `Skill '${skillId}' not found. ${listing}`;
};

// ── NoResponse ────────────────────────────────────────────────────────────

export const localNoResponse = async (): Promise<string> => {
  return "";
};
