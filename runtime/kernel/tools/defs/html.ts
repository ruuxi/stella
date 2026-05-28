/**
 * `html` tool — write a self-contained HTML document under
 * `~/.stella/outputs/html/<slug>.html` and surface it inline in the chat as a
 * canvas artifact. The completed file is opened in the workspace panel's
 * Canvas tab. You should not describe the canvas contents in chat, because
 * the user can view the artifact directly.
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
import type { ToolDefinition } from "../types.js";

export type HtmlToolOptions = {
  stellaHome: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

export const createHtmlTool = (options: HtmlToolOptions): ToolDefinition => {
  const { stellaHome } = options;
  return {
    name: "html",
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    description:
      "Write a complete HTML document and show it as a canvas artifact in the workspace panel. Use whenever a richer answer than markdown helps — plans, diagrams (SVG), comparisons, mockups, dashboards, structured reports, documentation, long-form writeups, side-by-side options, anything with tables/colors/illustrations. Do NOT use to build a real Stella app (that's spawn_agent). The iframe has network — pull in Google Fonts, Tailwind, Chart.js, D3, three.js, icon sets, or any CDN asset that makes the canvas better. Returns immediately once the file is written.",
    promptSnippet:
      "Write a self-contained HTML doc to ~/.stella/outputs/html/<slug>.html and show it in the Canvas tab",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Short kebab-case identifier for this canvas (e.g. 'onboarding-options'). Used as the filename. Lowercase letters, digits, hyphens; max 64 chars. If a canvas with the same slug already exists it is overwritten — use the same slug to iterate, a new slug for a new canvas.",
        },
        title: {
          type: "string",
          description:
            "Short human-readable title shown on the canvas tab/card (e.g. 'Onboarding — 6 directions').",
        },
        html: {
          type: "string",
          description:
            "Complete <!doctype html> document. The iframe has network — freely pull in Google Fonts, Tailwind, Chart.js, D3, three.js, icon sets, or any CDN asset via <link>, <script src>, or @import. Aim for a polished native-feeling canvas: spacious layout, soft borders, rounded cards, subtle shadows, Cormorant for display type and Manrope for body.",
        },
      },
      required: ["slug", "title", "html"],
    },
    execute: async (args) => {
      const rawSlug = asTrimmedString(args.slug);
      const title = asTrimmedString(args.title);
      const html = typeof args.html === "string" ? args.html : "";

      if (!title) return { error: "title is required." };
      if (html.length === 0) return { error: "html is required." };

      const slug = SLUG_RE.test(rawSlug) ? rawSlug : slugify(rawSlug || title);
      const dir = path.join(stellaHome, "outputs", "html");
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

      const createdAt = Date.now();

      return {
        result: `Canvas "${title}" saved to ${filePath} and opened in the panel.`,
        details: {
          filePath,
          slug,
          title,
          createdAt,
          bytes: Buffer.byteLength(html, "utf8"),
        },
        fileChanges: [fileChange(filePath, { type: kind })],
      };
    },
  };
};
