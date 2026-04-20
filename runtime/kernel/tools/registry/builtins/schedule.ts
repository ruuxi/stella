/**
 * Scheduling tools for the Exec registry: `schedule`, `heartbeat_*`, `cron_*`.
 */

import {
  handleCronAdd,
  handleCronList,
  handleCronRemove,
  handleCronRun,
  handleCronUpdate,
  handleHeartbeatGet,
  handleHeartbeatRun,
  handleHeartbeatUpsert,
  handleSchedule,
} from "../../schedule.js";
import type { ScheduleToolApi, TaskToolApi, ToolResult } from "../../types.js";
import type { ExecToolDefinition } from "../registry.js";

const SCHEDULE_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "Natural-language scheduling request (cron + heartbeat). The schedule subagent reconciles your request with current state.",
    },
  },
  required: ["prompt"],
} as const;

const CONVERSATION_SCHEMA = {
  type: "object",
  properties: {
    conversationId: {
      type: "string",
      description:
        "Override conversation id (defaults to the current conversation).",
    },
  },
} as const;

const HEARTBEAT_UPSERT_SCHEMA = {
  type: "object",
  properties: {
    conversationId: { type: "string", description: "Override conversation id." },
    enabled: { type: "boolean", description: "Whether the heartbeat is active." },
    intervalMs: {
      type: "number",
      description: "Interval in milliseconds (minimum 60000).",
    },
    prompt: { type: "string", description: "Heartbeat prompt." },
    checklist: { type: "string", description: "Heartbeat checklist." },
    ackMaxChars: { type: "number" },
    deliver: { type: "boolean" },
    agentType: { type: "string" },
    activeHours: {
      type: "object",
      properties: {
        start: { type: "string" },
        end: { type: "string" },
        timezone: { type: "string" },
      },
    },
    targetDeviceId: { type: "string" },
  },
} as const;

const CRON_ADD_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    schedule: {
      description:
        "Cron schedule object: `{ kind: 'at', atMs }`, `{ kind: 'every', everyMs, anchorMs? }`, or `{ kind: 'cron', expr, tz? }`.",
    },
    payload: {
      description:
        "Cron payload: `{ kind: 'systemEvent', text }` or `{ kind: 'agentTurn', message }`.",
    },
    sessionTarget: {
      type: "string",
      enum: ["main", "isolated"],
    },
    enabled: { type: "boolean" },
    deleteAfterRun: { type: "boolean" },
    conversationId: { type: "string" },
  },
  required: ["name", "schedule", "payload", "sessionTarget"],
} as const;

const CRON_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    jobId: { type: "string" },
    patch: { type: "object" },
  },
  required: ["jobId", "patch"],
} as const;

const CRON_ID_SCHEMA = {
  type: "object",
  properties: {
    jobId: { type: "string" },
  },
  required: ["jobId"],
} as const;

const unwrap = (result: ToolResult) => {
  if (result.error) throw new Error(result.error);
  return result.result;
};

export type ScheduleBuiltinOptions = {
  scheduleApi?: ScheduleToolApi;
  taskApi?: TaskToolApi;
  /**
   * Agent types allowed to use heartbeat/cron tools directly. Defaults to all
   * agents.
   */
  agentTypes?: readonly string[];
  /**
   * Agent types allowed to delegate via `tools.schedule`. The schedule
   * subagent is intentionally excluded to prevent recursion.
   */
  scheduleDelegateAgentTypes?: readonly string[];
};

export const createScheduleBuiltins = (
  options: ScheduleBuiltinOptions,
): ExecToolDefinition[] => {
  const agentTypes = options.agentTypes;
  const scheduleAgentTypes = options.scheduleDelegateAgentTypes ?? agentTypes;
  const def = (tool: Omit<ExecToolDefinition, "agentTypes">) =>
    agentTypes ? { ...tool, agentTypes } : tool;
  return [
    {
      name: "schedule",
      description:
        "Apply a local scheduling change in plain language. Internally hands off to the schedule subagent.",
      ...(scheduleAgentTypes ? { agentTypes: scheduleAgentTypes } : {}),
      inputSchema: SCHEDULE_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleSchedule(
            options.taskApi,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    },
    def({
      name: "heartbeat_get",
      description: "Read the current heartbeat configuration for a conversation.",
      inputSchema: CONVERSATION_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleHeartbeatGet(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    }),
    def({
      name: "heartbeat_upsert",
      description: "Create or update the local heartbeat configuration.",
      inputSchema: HEARTBEAT_UPSERT_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleHeartbeatUpsert(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    }),
    def({
      name: "heartbeat_run",
      description: "Trigger the local heartbeat immediately.",
      inputSchema: CONVERSATION_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleHeartbeatRun(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    }),
    def({
      name: "cron_list",
      description: "List all local cron jobs (newest first).",
      inputSchema: { type: "object", properties: {} } as const,
      handler: async () => unwrap(await handleCronList(options.scheduleApi)),
    }),
    def({
      name: "cron_add",
      description: "Create a new local cron job.",
      inputSchema: CRON_ADD_SCHEMA,
      handler: async (rawArgs, context) =>
        unwrap(
          await handleCronAdd(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
            context,
          ),
        ),
    }),
    def({
      name: "cron_update",
      description: "Update an existing local cron job (partial patch).",
      inputSchema: CRON_UPDATE_SCHEMA,
      handler: async (rawArgs) =>
        unwrap(
          await handleCronUpdate(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
          ),
        ),
    }),
    def({
      name: "cron_remove",
      description: "Permanently delete a local cron job.",
      inputSchema: CRON_ID_SCHEMA,
      handler: async (rawArgs) =>
        unwrap(
          await handleCronRemove(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
          ),
        ),
    }),
    def({
      name: "cron_run",
      description: "Trigger a local cron job immediately.",
      inputSchema: CRON_ID_SCHEMA,
      handler: async (rawArgs) =>
        unwrap(
          await handleCronRun(
            options.scheduleApi,
            rawArgs as Record<string, unknown>,
          ),
        ),
    }),
  ];
};
