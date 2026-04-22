/**
 * `Schedule` — orchestrator-only natural-language scheduling delegator.
 *
 * Takes a plain-language prompt and routes it to the schedule specialist
 * agent which builds the actual cron / heartbeat configuration.
 */

import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import { handleSchedule } from "../schedule.js";
import type {
  ScheduleToolApi,
  TaskToolApi,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types.js";

export type ScheduleToolOptions = {
  taskApi?: TaskToolApi;
  scheduleApi?: ScheduleToolApi;
};

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

export const createScheduleTool = (
  options: ScheduleToolOptions,
): ToolDefinition => ({
  name: "Schedule",
  description:
    "Handle local scheduling requests in plain language. Delegates to the schedule specialist and returns a short summary.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Plain-language scheduling request for local cron jobs and heartbeats.",
      },
    },
    required: ["prompt"],
  },
  execute: async (args, context) => {
    const denied = requireOrchestrator("Schedule", context);
    if (denied) return denied;
    try {
      return await handleSchedule(options.taskApi, args, context);
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
