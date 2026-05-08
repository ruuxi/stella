/**
 * `html` tool — write a self-contained HTML document under
 * `state/outputs/html/<slug>.html` and surface it inline in the chat as a
 * canvas artifact. The completed file is opened in the workspace panel's
 * Canvas tab; the model should not say "rendered" or describe what's on
 * screen — the user already sees the canvas.
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
  stellaRoot: string;
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
  const { stellaRoot } = options;
  return {
    name: "html",
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    description:
      "Write a self-contained HTML document and show it as a canvas artifact in the workspace panel. Use whenever a visually richer answer than markdown helps — plans, diagrams (SVG), comparisons, mockups, dashboards, structured reports, side-by-side options, anything with tables/colors/illustrations. Do NOT use to build a real Stella app (that's spawn_agent). The HTML must be a complete <!doctype html> document with all CSS/JS inline and no external resources. Returns immediately once the file is written.",
    promptSnippet:
      "Write a self-contained HTML doc to state/outputs/html/<slug>.html and show it in the Canvas tab",
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
            "Complete <!doctype html> document. Inline all CSS in <style>; inline all JS in <script>; do not link to external stylesheets or fonts (the app is offline-capable). Use Stella's design vocabulary: CSS variables --background, --foreground, --card, --border, --accent, --radius-*, and font families var(--font-family-display) (Cormorant), var(--font-family-sans) (Manrope), var(--font-family-mono). The canvas inherits these; do NOT paint a hard background colour — let the global gradient show through.",
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
      const dir = path.join(stellaRoot, "state", "outputs", "html");
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
