/**
 * `html` tool — write a self-contained HTML document under
 * `~/.stella/outputs/html/<slug>.html` and surface it inline in the chat as a
 * canvas artifact. The completed file becomes a page in the user's canvas
 * library (`stella-canvas://library`), shown in the workspace panel's Canvas
 * tab. Each write also upserts a manifest entry so the library shell can
 * list, search, and group every page ever produced — the model never
 * maintains the index itself.
 *
 * Orchestrator-only. The general agent builds real apps via Vite/HMR;
 * this tool exists so the orchestrator can answer with a richer-than-
 * markdown artifact (planning, comparisons, diagrams, dashboards,
 * mockups, structured reports) without spawning an agent.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import { fileChange } from "../../../contracts/file-changes.js";
import { upsertCanvasLibraryEntry } from "../../shared/canvas-library-manifest.js";
import type { ToolDefinition } from "../types.js";

export type HtmlToolOptions = {
  stellaDataDir: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 24;
const MAX_DESCRIPTION_LENGTH = 200;

const slugify = (raw: string): string => {
  const lowered = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return lowered.length > 0 ? lowered : `canvas-${Date.now().toString(36)}`;
};

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const raw of value) {
    const tag = asTrimmedString(raw).toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
};

export const createHtmlTool = (options: HtmlToolOptions): ToolDefinition => {
  const { stellaDataDir } = options;
  return {
    name: "html",
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    description:
      "Write a complete HTML document and publish it as a page in the user's canvas library (shown in the workspace panel). Use whenever a richer answer than markdown helps — plans, diagrams (SVG), comparisons, mockups, dashboards, structured reports, documentation, long-form writeups, side-by-side options, anything with tables/colors/illustrations. Pages persist: the library lists, groups, and searches every page, so prefer updating an existing slug as work evolves (e.g. one report per task that grows) over piling up near-duplicate pages. Do NOT use to build a real Stella app (that's spawn_agent). The iframe has network — pull in Google Fonts, Tailwind, Chart.js, D3, three.js, icon sets, or any CDN asset that makes the canvas better. Returns immediately once the file is written.",
    promptSnippet:
      "Write a self-contained HTML doc to ~/.stella/outputs/html/<slug>.html; it becomes a page in the user's canvas library (Canvas tab)",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Short kebab-case identifier for this canvas (e.g. 'onboarding-options'). Used as the filename. Lowercase letters, digits, hyphens; max 64 chars. If a canvas with the same slug already exists it is overwritten — use the same slug to iterate or keep a living page updated, a new slug for a new page.",
        },
        title: {
          type: "string",
          description:
            "Short human-readable title shown on the page's library card (e.g. 'Onboarding — 6 directions').",
        },
        description: {
          type: "string",
          description:
            "One-sentence summary shown under the title on the library card and used for search. Plain text, max 200 chars.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Up to 6 short lowercase tags used to group and filter pages in the library (e.g. ['planning', 'q3']). Reuse existing tags when iterating on related work.",
        },
        html: {
          type: "string",
          description:
            "Complete <!doctype html> document. The iframe has network — freely pull in Google Fonts, Tailwind, Chart.js, D3, three.js, icon sets, or any CDN asset via <link>, <script src>, or @import. Aim for a polished native-feeling canvas: spacious layout, soft borders, rounded cards, subtle shadows, Cormorant for display type and Manrope for body.",
        },
      },
      required: ["slug", "title", "html"],
    },
    execute: async (args, context) => {
      const rawSlug = asTrimmedString(args.slug);
      const title = asTrimmedString(args.title);
      const description = asTrimmedString(args.description).slice(
        0,
        MAX_DESCRIPTION_LENGTH,
      );
      const tags = asTags(args.tags);
      const html = typeof args.html === "string" ? args.html : "";

      if (!title) return { error: "title is required." };
      if (html.length === 0) return { error: "html is required." };

      const slug = SLUG_RE.test(rawSlug) ? rawSlug : slugify(rawSlug || title);
      const dir = path.join(stellaDataDir, "outputs", "html");
      const filePath = path.join(dir, `${slug}.html`);

      let kind: "add" | "update";
      try {
        await fs.access(filePath);
        kind = "update";
      } catch {
        kind = "add";
      }

      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, html, "utf8");

      const entry = await upsertCanvasLibraryEntry(stellaDataDir, {
        slug,
        title,
        ...(description ? { description } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(context.conversationId
          ? { conversationId: context.conversationId }
          : {}),
        ...(context.runId ? { runId: context.runId } : {}),
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.agentType ? { agentType: context.agentType } : {}),
      });

      return {
        result: `Canvas "${title}" saved to ${filePath} and published to the library (page /a/${slug}).`,
        details: {
          filePath,
          slug,
          title,
          createdAt: entry.updatedAt,
          bytes: Buffer.byteLength(html, "utf8"),
        },
        fileChanges: [fileChange(filePath, { type: kind })],
      };
    },
  };
};
