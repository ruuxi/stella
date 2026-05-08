import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduleToolAffectedRef,
  ScheduleToolChangeSet,
  ScheduleToolDetails,
} from "../shared/scheduling.js";
import type {
  ScheduleToolApi,
  AgentToolApi,
  ToolContext,
  ToolResult,
} from "./types.js";

const formatResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

const SCHEDULE_TASK_TIMEOUT_MS = 45_000;
const SCHEDULE_TASK_POLL_MS = 150;

const getConversationId = (
  args: Record<string, unknown>,
  context: ToolContext,
): string => {
  const explicit =
    typeof args.conversationId === "string" ? args.conversationId.trim() : "";
  return explicit || context.conversationId;
};

const requireScheduleApi = (scheduleApi?: ScheduleToolApi): ScheduleToolApi => {
  if (!scheduleApi) {
    throw new Error("Scheduling is not configured on this device.");
  }
  return scheduleApi;
};

const requireAgentApi = (agentApi?: AgentToolApi): AgentToolApi => {
  if (!agentApi) {
    throw new Error("Agent orchestration is not configured on this device.");
  }
  return agentApi;
};

const getSchedulePrompt = (args: Record<string, unknown>) => {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    throw new Error("prompt is required.");
  }
  return prompt;
};

const buildScheduleTaskPrompt = (
  prompt: string,
  context: ToolContext,
) => `Apply this local scheduling request for conversation ${context.conversationId}.

User request:
${prompt}

Instructions:
- Use only the available cron and heartbeat tools.
- Default to this conversation unless the request explicitly names another one.
- Check existing schedule state before making changes when that helps avoid duplicates or conflicts.
- Prefer updating an existing matching heartbeat over creating redundant state.
- Make reasonable, conservative assumptions when details are missing, and mention any important assumption in your final reply.
- Return plain text only: a short summary of what you changed, or say clearly if no change was needed.`;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Best-effort schedule snapshot scoped to a single conversation. Heartbeat
 * is per-conversation (`getHeartbeatConfig`); crons are global so we filter
 * by `conversationId` here.
 *
 * Failures resolve to an empty snapshot — the schedule subagent has its own
 * authoritative path to persist changes; this helper exists only to power
 * the structured `details` side-channel for the inline receipt chip.
 */
const snapshotConversationSchedules = async (
  api: ScheduleToolApi | undefined,
  conversationId: string,
): Promise<{
  crons: Map<string, LocalCronJobRecord>;
  heartbeat: LocalHeartbeatConfigRecord | null;
}> => {
  if (!api) return { crons: new Map(), heartbeat: null };
  try {
    const [allCrons, heartbeat] = await Promise.all([
      api.listCronJobs(),
      api.getHeartbeatConfig(conversationId),
    ]);
    const crons = new Map<string, LocalCronJobRecord>();
    for (const cron of allCrons) {
      if (cron.conversationId === conversationId) {
        crons.set(cron.id, cron);
      }
    }
    return { crons, heartbeat };
  } catch {
    return { crons: new Map(), heartbeat: null };
  }
};

const heartbeatDisplayName = (record: LocalHeartbeatConfigRecord): string => {
  const prompt = record.prompt?.trim();
  if (!prompt) return "Check-in";
  return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
};

const cronToAffected = (record: LocalCronJobRecord): ScheduleToolAffectedRef => ({
  kind: "cron",
  id: record.id,
  conversationId: record.conversationId,
  name: record.name?.trim() || "Scheduled task",
  enabled: record.enabled,
  nextRunAtMs: record.nextRunAtMs,
});

const heartbeatToAffected = (
  record: LocalHeartbeatConfigRecord,
): ScheduleToolAffectedRef => ({
  kind: "heartbeat",
  id: record.id,
  conversationId: record.conversationId,
  name: heartbeatDisplayName(record),
  enabled: record.enabled,
  nextRunAtMs: record.nextRunAtMs,
});

/**
 * Diff a before/after snapshot of one conversation's schedules into the
 * structured `ScheduleToolDetails` shape consumed by the chat UI's inline
 * receipt chip. `updated` is detected via `updatedAt` divergence rather
 * than deep equality — the scheduler bumps `updatedAt` on every mutation
 * and skips it on no-op writes.
 */
const buildScheduleDetails = (
  before: {
    crons: Map<string, LocalCronJobRecord>;
    heartbeat: LocalHeartbeatConfigRecord | null;
  },
  after: {
    crons: Map<string, LocalCronJobRecord>;
    heartbeat: LocalHeartbeatConfigRecord | null;
  },
): ScheduleToolDetails => {
  const affected: ScheduleToolAffectedRef[] = [];
  const changes: ScheduleToolChangeSet = {
    added: [],
    updated: [],
    removed: [],
  };

  for (const [id, cron] of after.crons) {
    const prior = before.crons.get(id);
    if (!prior) {
      changes.added.push({ kind: "cron", id });
      affected.push(cronToAffected(cron));
    } else if (cron.updatedAt > prior.updatedAt) {
      changes.updated.push({ kind: "cron", id });
      affected.push(cronToAffected(cron));
    }
  }
  for (const id of before.crons.keys()) {
    if (!after.crons.has(id)) {
      changes.removed.push({ kind: "cron", id });
    }
  }

  if (after.heartbeat && !before.heartbeat) {
    changes.added.push({ kind: "heartbeat", id: after.heartbeat.id });
    affected.push(heartbeatToAffected(after.heartbeat));
  } else if (after.heartbeat && before.heartbeat) {
    if (after.heartbeat.updatedAt > before.heartbeat.updatedAt) {
      changes.updated.push({ kind: "heartbeat", id: after.heartbeat.id });
      affected.push(heartbeatToAffected(after.heartbeat));
    }
  } else if (!after.heartbeat && before.heartbeat) {
    changes.removed.push({ kind: "heartbeat", id: before.heartbeat.id });
  }

  affected.sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);
  return { schedule: { affected, changes } };
};

const isEmptyDetails = (details: ScheduleToolDetails): boolean =>
  details.schedule.affected.length === 0 &&
  details.schedule.changes.added.length === 0 &&
  details.schedule.changes.updated.length === 0 &&
  details.schedule.changes.removed.length === 0;

export const handleSchedule = async (
  agentApi: AgentToolApi | undefined,
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireAgentApi(agentApi);
  const prompt = getSchedulePrompt(args);
  const nextAgentDepth = Math.max(0, context.agentDepth ?? 0) + 1;

  // Snapshot before so the post-run diff identifies exactly which schedules
  // the subagent created / updated / removed. Failures here resolve to an
  // empty snapshot, in which case the diff just reports everything visible
  // afterwards as `added`.
  const before = await snapshotConversationSchedules(
    scheduleApi,
    context.conversationId,
  );

  const created = await api.createAgent({
    conversationId: context.conversationId,
    description: "Apply local scheduling changes",
    prompt: buildScheduleTaskPrompt(prompt, context),
    agentType: "schedule",
    rootRunId: context.rootRunId,
    agentDepth: nextAgentDepth,
    ...(typeof context.maxAgentDepth === "number"
      ? { maxAgentDepth: context.maxAgentDepth }
      : {}),
    parentAgentId: context.cloudAgentId ?? context.agentId,
    storageMode: context.storageMode ?? "local",
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < SCHEDULE_TASK_TIMEOUT_MS) {
    const snapshot = await api.getAgent(created.threadId);
    if (!snapshot) {
      throw new Error(`Schedule task not found: ${created.threadId}`);
    }
    if (snapshot.status === "completed") {
      const summary =
        typeof snapshot.result === "string" && snapshot.result.trim().length > 0
          ? snapshot.result
          : "Scheduling updated.";
      const after = await snapshotConversationSchedules(
        scheduleApi,
        context.conversationId,
      );
      const details = buildScheduleDetails(before, after);
      return {
        result: summary,
        ...(isEmptyDetails(details) ? {} : { details }),
      };
    }
    if (snapshot.status === "error" || snapshot.status === "canceled") {
      throw new Error(snapshot.error || "Scheduling request failed.");
    }
    await sleep(SCHEDULE_TASK_POLL_MS);
  }

  await api.cancelAgent(
    created.threadId,
    "Schedule tool timed out waiting for completion.",
  );
  throw new Error("Scheduling request timed out.");
};

export const handleHeartbeatGet = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const result = await api.getHeartbeatConfig(getConversationId(args, context));
  return { result: formatResult(result) };
};

export const handleHeartbeatUpsert = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const result = await api.upsertHeartbeat({
    conversationId: getConversationId(args, context),
    ...(args.enabled !== undefined ? { enabled: Boolean(args.enabled) } : {}),
    ...(typeof args.intervalMs === "number" ? { intervalMs: args.intervalMs } : {}),
    ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
    ...(typeof args.checklist === "string" ? { checklist: args.checklist } : {}),
    ...(typeof args.ackMaxChars === "number" ? { ackMaxChars: args.ackMaxChars } : {}),
    ...(typeof args.deliver === "boolean" ? { deliver: args.deliver } : {}),
    ...(typeof args.agentType === "string" ? { agentType: args.agentType } : {}),
    ...(args.activeHours && typeof args.activeHours === "object"
      ? { activeHours: args.activeHours as { start: string; end: string; timezone?: string } }
      : {}),
    ...(typeof args.targetDeviceId === "string"
      ? { targetDeviceId: args.targetDeviceId }
      : {}),
  });
  return { result: formatResult(result) };
};

export const handleHeartbeatRun = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const result = await api.runHeartbeat(getConversationId(args, context));
  return { result: formatResult(result) };
};

export const handleCronList = async (
  scheduleApi: ScheduleToolApi | undefined,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const result = await api.listCronJobs();
  return { result: formatResult(result) };
};

export const handleCronAdd = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const result = await api.addCronJob({
    name: typeof args.name === "string" ? args.name : "",
    schedule: args.schedule as never,
    payload: args.payload as never,
    conversationId: getConversationId(args, context),
    ...(typeof args.description === "string" ? { description: args.description } : {}),
    ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
    ...(typeof args.deliver === "boolean" ? { deliver: args.deliver } : {}),
    ...(typeof args.deleteAfterRun === "boolean"
      ? { deleteAfterRun: args.deleteAfterRun }
      : {}),
  });
  return { result: formatResult(result) };
};

export const handleCronUpdate = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const jobId = typeof args.jobId === "string" ? args.jobId : "";
  const patch = args.patch && typeof args.patch === "object"
    ? (args.patch as Record<string, unknown>)
    : {};
  const result = await api.updateCronJob(jobId, {
    ...(typeof patch.name === "string" ? { name: patch.name } : {}),
    ...(patch.schedule !== undefined ? { schedule: patch.schedule as never } : {}),
    ...(patch.payload !== undefined ? { payload: patch.payload as never } : {}),
    ...(typeof patch.conversationId === "string"
      ? { conversationId: patch.conversationId }
      : {}),
    ...(typeof patch.description === "string" ? { description: patch.description } : {}),
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch.deliver === "boolean" ? { deliver: patch.deliver } : {}),
    ...(typeof patch.deleteAfterRun === "boolean"
      ? { deleteAfterRun: patch.deleteAfterRun }
      : {}),
  });
  return { result: formatResult(result) };
};

export const handleCronRemove = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const removed = await api.removeCronJob(
    typeof args.jobId === "string" ? args.jobId : "",
  );
  return { result: removed ? "Cron job removed." : "Cron job not found." };
};

export const handleCronRun = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const result = await api.runCronJob(
    typeof args.jobId === "string" ? args.jobId : "",
  );
  return { result: formatResult(result) };
};
