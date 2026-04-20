/**
 * Display tools for the Exec registry. Display surfaces only register when
 * the host has a `displayHtml` callback (typically the Electron renderer).
 */

import type { ExecToolDefinition } from "../registry.js";

const DISPLAY_GUIDELINES_SCHEMA = {
  type: "object",
  properties: {
    modules: {
      type: "array",
      items: {
        type: "string",
        enum: ["interactive", "chart", "mockup", "art", "diagram", "text"],
      },
      description: "Which guideline module(s) to load.",
    },
  },
  required: ["modules"],
} as const;

const DISPLAY_SCHEMA = {
  type: "object",
  properties: {
    html: {
      type: "string",
      description:
        "HTML or SVG fragment to render. SVG starts with <svg>; HTML is a fragment without <html>/<head>/<body>.",
    },
    i_have_read_guidelines: {
      type: "boolean",
      description:
        "Confirm `display_guidelines` was called earlier in this conversation.",
    },
  },
  required: ["html", "i_have_read_guidelines"],
} as const;

export type DisplayBuiltinOptions = {
  displayHtml?: (html: string) => void;
};

export const createDisplayBuiltins = (
  options: DisplayBuiltinOptions,
): ExecToolDefinition[] => {
  const tools: ExecToolDefinition[] = [
    {
      name: "display_guidelines",
      description:
        "Load Display design guidelines (CSS, typography, layout). Call before the first `display` invocation in a conversation.",
      inputSchema: DISPLAY_GUIDELINES_SCHEMA,
      handler: async (rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        const modules = Array.isArray(args.modules)
          ? (args.modules as string[])
          : [];
        if (modules.length === 0) throw new Error("modules are required.");
        const { getDisplayGuidelines } = await import(
          "../../display-guidelines.js"
        );
        return { guidelines: getDisplayGuidelines(modules) };
      },
    },
  ];
  if (options.displayHtml) {
    tools.push({
      name: "display",
      description:
        "Render HTML or SVG on the canvas panel. Call `display_guidelines` first; pass `i_have_read_guidelines: true` after.",
      inputSchema: DISPLAY_SCHEMA,
      handler: async (rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        if (!args.i_have_read_guidelines) {
          throw new Error(
            "Call `display_guidelines` first; then pass `i_have_read_guidelines: true`.",
          );
        }
        const html = String(args.html ?? "");
        if (!html) throw new Error("html is required.");
        options.displayHtml!(html);
        return { displayed: true };
      },
    });
  }
  return tools;
};
