/**
 * Schedule subagent surface — heartbeat config + cron jobs.
 *
 * Eight sibling tools that mutate the local scheduling state directly. Used
 * exclusively by the Schedule subagent (the orchestrator delegates plain-
 * language requests to it via the `Schedule` tool).
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
} from "../schedule.js";
import type { ScheduleToolApi, ToolDefinition } from "../types.js";

export type ScheduleControlOptions = {
  scheduleApi?: ScheduleToolApi;
};

const HEARTBEAT_CONVERSATION_PROPERTIES = {
  conversationId: {
    type: "string",
    description:
      "Optional override for the conversation whose heartbeat to address. Defaults to the current conversation.",
  },
} as const;

const CRON_JOB_ID_PROPERTY = {
  type: "string",
  description: "Identifier returned by CronAdd / CronList.",
} as const;

const CRON_JOB_PAYLOAD_PROPERTIES = {
  name: { type: "string", description: "Human label shown to the user." },
  description: {
    type: "string",
    description: "Optional explanation shown in CronList.",
  },
  schedule: {
    type: "object",
    description:
      "Schedule definition: { kind: 'at', atMs } | { kind: 'every', everyMs, anchorMs? } | { kind: 'cron', expr, tz? }.",
  },
  payload: {
    type: "object",
    description:
      "Three tiers — pick the cheapest that fits.\n• `{ kind: 'notify', text }` — literal message delivered each fire (and an OS notification). No LLM, no script.\n• `{ kind: 'script', scriptPath }` — runs the file at scriptPath via `bun run`; trimmed stdout becomes the message (empty = silent fire). Author & test the script first via `ScriptDraft`, then pass the returned `scriptPath` here.\n• `{ kind: 'agent', prompt, agentType? }` — runs an isolated worker turn each fire with the fixed prompt; defaults to the general agent. Use only when reasoning or multi-tool work is required at fire time.",
  },
  enabled: { type: "boolean", description: "Whether the job is active." },
  deliver: {
    type: "boolean",
    description:
      "When false, suppress the message + OS notification even if the fire produces text. Defaults to true.",
  },
  deleteAfterRun: {
    type: "boolean",
    description:
      "Remove the job (and its script file, if any) once it has fired successfully. Only meaningful for `schedule.kind = 'at'`.",
  },
} as const;

export const createScheduleControlTools = (
  options: ScheduleControlOptions,
): ToolDefinition[] => [
  {
    name: "HeartbeatGet",
    description:
      "Read the current heartbeat configuration for the target conversation (or the current one).",
    parameters: {
      type: "object",
      properties: HEARTBEAT_CONVERSATION_PROPERTIES,
    },
    execute: (args, context) =>
      handleHeartbeatGet(options.scheduleApi, args, context),
  },
  {
    name: "HeartbeatUpsert",
    description:
      "Create or update the heartbeat for a conversation. Pass only the fields you want to change.",
    parameters: {
      type: "object",
      properties: {
        ...HEARTBEAT_CONVERSATION_PROPERTIES,
        enabled: { type: "boolean", description: "Whether heartbeats fire." },
        intervalMs: {
          type: "number",
          description: "How often (in ms) the heartbeat should fire.",
        },
        prompt: {
          type: "string",
          description: "The prompt delivered each heartbeat.",
        },
        checklist: {
          type: "string",
          description: "Optional checklist appended to the prompt.",
        },
        ackMaxChars: {
          type: "number",
          description: "Cap on ack characters returned to the model.",
        },
        deliver: {
          type: "boolean",
          description:
            "Whether to deliver the heartbeat as a visible message vs run silently.",
        },
        agentType: {
          type: "string",
          description: "Which agent should handle the heartbeat.",
        },
        activeHours: {
          type: "object",
          description:
            "Window during which the heartbeat is allowed to fire (start, end, optional timezone).",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
            timezone: { type: "string" },
          },
          required: ["start", "end"],
        },
        targetDeviceId: {
          type: "string",
          description:
            "Optional device id to restrict the heartbeat to a specific device.",
        },
      },
    },
    execute: (args, context) =>
      handleHeartbeatUpsert(options.scheduleApi, args, context),
  },
  {
    name: "HeartbeatRun",
    description: "Fire the heartbeat now (out-of-cycle), without changing config.",
    parameters: {
      type: "object",
      properties: HEARTBEAT_CONVERSATION_PROPERTIES,
    },
    execute: (args, context) =>
      handleHeartbeatRun(options.scheduleApi, args, context),
  },
  {
    name: "CronList",
    description: "List all local cron jobs.",
    parameters: { type: "object", properties: {} },
    execute: () => handleCronList(options.scheduleApi),
  },
  {
    name: "CronAdd",
    description: "Create a new local cron job.",
    parameters: {
      type: "object",
      properties: {
        ...HEARTBEAT_CONVERSATION_PROPERTIES,
        ...CRON_JOB_PAYLOAD_PROPERTIES,
      },
      required: ["name", "schedule", "payload"],
    },
    execute: (args, context) =>
      handleCronAdd(options.scheduleApi, args, context),
  },
  {
    name: "CronUpdate",
    description: "Patch an existing cron job. Pass only the fields you want to change.",
    parameters: {
      type: "object",
      properties: {
        jobId: CRON_JOB_ID_PROPERTY,
        patch: {
          type: "object",
          description: "Subset of cron fields to change.",
          properties: CRON_JOB_PAYLOAD_PROPERTIES,
        },
      },
      required: ["jobId", "patch"],
    },
    execute: (args) => handleCronUpdate(options.scheduleApi, args),
  },
  {
    name: "CronRemove",
    description: "Remove a cron job.",
    parameters: {
      type: "object",
      properties: { jobId: CRON_JOB_ID_PROPERTY },
      required: ["jobId"],
    },
    execute: (args) => handleCronRemove(options.scheduleApi, args),
  },
  {
    name: "CronRun",
    description: "Run a cron job immediately (out-of-cycle).",
    parameters: {
      type: "object",
      properties: { jobId: CRON_JOB_ID_PROPERTY },
      required: ["jobId"],
    },
    execute: (args) => handleCronRun(options.scheduleApi, args),
  },
];
