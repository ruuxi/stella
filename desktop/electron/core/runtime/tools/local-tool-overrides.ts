/**
 * Local tool implementations for tools that don't need the server.
 *
 * These replace the backend passthrough (`callBackendTool`) for tools
 * that can execute entirely in the Electron process:
 * - WebFetch: direct fetch() + HTML-to-text
 * - ActivateSkill: read from install-root `.stella/skills/` on disk
 * - NoResponse: immediate return
 */

import path from "path";
import { loadSkillsFromHome } from "../agents/skills.js";
import { normalizeSafeExternalUrl } from "./network-guards.js";

const MAX_FETCH_BODY_CHARS = 80_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_REDIRECTS = 5;

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

// ActivateSkill

const SKILL_DIRS = ["skills", "core-skills"] as const;

const formatMissingSkillMessage = (skillId: string, available: string[]) => {
  const listing = available.length > 0
    ? `Available skills: ${available.join(", ")}`
    : "No skills are currently installed.";
  return `Skill '${skillId}' not found. ${listing}`;
};

export const localActivateSkill = async (args: {
  skillId: string;
  stellaHome: string;
  allowedSkillIds?: string[];
}): Promise<string> => {
  const { skillId, stellaHome, allowedSkillIds } = args;
  if (!skillId) return "Error: skillId is required.";

  if (/[/\\]|\.\./.test(skillId)) {
    return "Error: invalid skillId.";
  }

  const allowed = Array.isArray(allowedSkillIds)
    ? Array.from(new Set(allowedSkillIds.filter((value) => value.trim().length > 0)))
    : null;
  if (allowed && !allowed.includes(skillId)) {
    return formatMissingSkillMessage(skillId, allowed);
  }

  const skills = await loadSkillsFromHome(
    ...SKILL_DIRS.map((subdir) => path.join(stellaHome, subdir)),
  );
  const skill = skills.find((entry) => entry.id === skillId);
  if (skill) {
    return skill.markdown;
  }

  return formatMissingSkillMessage(skillId, allowed ?? skills.map((entry) => entry.id));
};

// NoResponse

export const localNoResponse = async (): Promise<string> => {
  return "";
};
