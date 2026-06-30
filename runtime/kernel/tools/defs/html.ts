/**
 * `html` tool — render a brief into a self-contained HTML document under
 * `~/.stella/outputs/html/<slug>.html` and surface it inline in the chat as a
 * canvas artifact. The completed file is opened in the workspace panel's
 * Canvas tab. You should not describe the canvas contents in chat, because
 * the user can view the artifact directly.
 *
 * Orchestrator-only and standalone: the orchestrator calls it by its own
 * judgment, at any time — mid-conversation or after distilling an agent's
 * finish output. It does NOT write the HTML itself. It passes a brief (intent
 * + content/substance + desired feel) and, optionally, a scoped slice of
 * context; a dedicated HTML generation LLM turns that into the actual document.
 *
 * The general agent builds real apps via Vite/HMR; this tool exists so the
 * orchestrator can answer with a richer-than-markdown artifact (planning,
 * comparisons, diagrams, dashboards, mockups, structured reports) without
 * spawning an agent.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import { fileChange } from "../../../contracts/file-changes.js";
import type { HtmlGenerateFn, ToolDefinition } from "../types.js";

export type HtmlToolOptions = {
  stellaDataDir: string;
  /**
   * Standalone HTML generation LLM. Turns the brief (+ optional scoped
   * context) into the actual document. When absent, the tool reports that
   * canvas generation is unavailable instead of writing an empty file.
   */
  generateHtml?: HtmlGenerateFn;
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
  const { stellaDataDir, generateHtml } = options;
  return {
    name: "html",
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    description:
      "Render a canvas artifact and show it in the workspace panel. Use whenever a richer answer than markdown helps — plans, diagrams (SVG), comparisons, mockups, dashboards, structured reports, documentation, long-form writeups, side-by-side options, anything with tables/colors/illustrations. You do NOT write the HTML: describe what to make in `brief` (intent + the content/substance to present + the desired feel) and a dedicated generator builds the self-contained document. Attach the relevant slice of conversation in `context` when the substance lives in prior turns (e.g. an agent's finish output) so the generator has it without seeing the whole history. Do NOT use to build a real Stella app (that's spawn_agent). Returns once the canvas is written.",
    promptSnippet:
      "Describe a canvas in `brief` (+ optional `context`); a generator renders it to ~/.stella/outputs/html/<slug>.html and shows it in the Canvas tab",
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
        brief: {
          type: "string",
          description:
            "What canvas to make, for the generator: the intent (what it's for), the actual content/substance to present (the real data, findings, options, copy — not a vague topic), and the desired feel/structure (e.g. side-by-side comparison cards, a dashboard with charts, a long-form report). Be concrete and faithful — the generator presents what you give it and must not invent facts.",
        },
        context: {
          type: "string",
          description:
            "Optional. The relevant slice of conversation/turns to ground the canvas — e.g. an agent's finish output or the last few load-bearing messages. Attach this when the substance lives in prior turns so the generator gets the detail without the full history. Omit when the brief already carries everything.",
        },
      },
      required: ["slug", "title", "brief"],
    },
    execute: async (args, _context, extras) => {
      const rawSlug = asTrimmedString(args.slug);
      const title = asTrimmedString(args.title);
      const brief = asTrimmedString(args.brief);
      const scopedContext = asTrimmedString(args.context);

      if (!title) return { error: "title is required." };
      if (!brief) return { error: "brief is required." };
      if (!generateHtml) {
        return { error: "Canvas generation is unavailable right now." };
      }

      let html: string | null;
      try {
        html = await generateHtml({
          brief,
          title,
          ...(scopedContext ? { scopedContext } : {}),
          ...(extras?.signal ? { abortSignal: extras.signal } : {}),
        });
      } catch (error) {
        return {
          error: `Canvas generation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (!html || html.trim().length === 0) {
        return {
          error:
            "Canvas generation produced no document. Try again with a clearer brief.",
        };
      }

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
