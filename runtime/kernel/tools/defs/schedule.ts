/**
 * `Schedule` — orchestrator-only natural-language scheduling delegator.
 *
 * Takes a plain-language prompt and routes it to the schedule specialist
 * agent which builds the actual cron / heartbeat configuration.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import { handleSchedule } from "../schedule.js";
import type {
  ScheduleToolApi,
  AgentToolApi,
  ToolDefinition,
} from "../types.js";

export type ScheduleToolOptions = {
  agentApi?: AgentToolApi;
  scheduleApi?: ScheduleToolApi;
};

export const createScheduleTool = (
  options: ScheduleToolOptions,
): ToolDefinition => ({
  name: "Schedule",
  // Orchestrator-only: gated declaratively. The catalog filter and
  // executeTool dispatcher in `tools/host.ts` enforce this for any agent.
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
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
    try {
      return await handleSchedule(
        options.agentApi,
        options.scheduleApi,
        args,
        context,
      );
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
