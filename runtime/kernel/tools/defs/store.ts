/**
 * `Store` — orchestrator-only natural-language store-publishing delegator.
 *
 * Mirrors the shape of `Schedule({ prompt })`: takes a plain-language
 * publishing request from the user (e.g. from the Store UI's "Publish"
 * button) and routes it to the Store specialist agent, which inspects
 * git history, confirms metadata with the user, and publishes.
 */

import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import { handleStore } from "../store.js";
import type {
  AgentToolApi,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types.js";

export type StoreToolOptions = {
  agentApi?: AgentToolApi;
};

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

export const createStoreTool = (
  options: StoreToolOptions,
): ToolDefinition => ({
  name: "Store",
  description:
    "Hand off a plain-language Stella Store publish request to the Store specialist. Use when the user wants to publish or update a mod from their recent Stella changes.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Plain-language publish request describing what the user wants to ship to the Store (e.g. 'publish my new notes page' or 'update the dark theme mod with my latest tweaks').",
      },
    },
    required: ["prompt"],
  },
  execute: async (args, context) => {
    const denied = requireOrchestrator("Store", context);
    if (denied) return denied;
    try {
      return await handleStore(options.agentApi, args, context);
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
