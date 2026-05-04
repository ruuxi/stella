/**
 * `Display` and `DisplayGuidelines` — orchestrator-only canvas tools.
 *
 * `DisplayGuidelines` returns design rules the model must read before its
 * first `Display` call. `Display` then renders an HTML or SVG fragment on
 * the side canvas via the injected renderer.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

export type DisplayToolOptions = {
  displayHtml?: (html: string) => void;
};

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

export const createDisplayTools = (
  options: DisplayToolOptions,
): ToolDefinition[] => {
  const displayGuidelinesTool: ToolDefinition = {
    name: "DisplayGuidelines",
    description:
      "Return design guidelines for Display (layout, CSS, typography, examples). Call once before first use.",
    parameters: {
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
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("DisplayGuidelines", context);
      if (denied) return denied;
      const modules = Array.isArray(args.modules)
        ? (args.modules as string[])
        : [];
      if (!modules.length) return { error: "modules parameter is required." };
      try {
        const { getDisplayGuidelines } = await import(
          "../display-guidelines.js"
        );
        return { result: getDisplayGuidelines(modules) };
      } catch (error) {
        return {
          error: `Failed to load guidelines: ${(error as Error).message}`,
        };
      }
    },
  };

  const displayTool: ToolDefinition = {
    name: "Display",
    description:
      "Render HTML or SVG on the canvas panel. Call DisplayGuidelines before the first Display call.",
    parameters: {
      type: "object",
      properties: {
        i_have_read_guidelines: {
          type: "boolean",
          description:
            "Confirm you already called DisplayGuidelines in this conversation.",
        },
        html: {
          type: "string",
          description:
            "HTML or SVG fragment to render. SVG should start with <svg>; HTML should be a fragment, not a full document.",
        },
      },
      required: ["i_have_read_guidelines", "html"],
    },
    execute: async (args, context) => {
      const denied = requireOrchestrator("Display", context);
      if (denied) return denied;
      if (!args.i_have_read_guidelines) {
        return {
          error:
            "You must call DisplayGuidelines before Display. Set i_have_read_guidelines: true after doing so.",
        };
      }
      const html = String(args.html ?? "");
      if (!html) return { error: "html parameter is required." };
      if (!options.displayHtml) {
        return { error: "Display is not available (no renderer connected)." };
      }
      options.displayHtml(html);
      return { result: "Display updated." };
    },
  };

  return [displayGuidelinesTool, displayTool];
};
