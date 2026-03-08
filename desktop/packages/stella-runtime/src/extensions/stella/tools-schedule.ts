import type {
  ScheduleToolApi,
  ToolContext,
  ToolResult,
} from "./tools-types.js";

const formatResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

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
    sessionTarget: (typeof args.sessionTarget === "string"
      ? args.sessionTarget
      : "") as "main" | "isolated",
    conversationId: getConversationId(args, context),
    ...(typeof args.description === "string" ? { description: args.description } : {}),
    ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
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
    ...(typeof patch.sessionTarget === "string"
      ? { sessionTarget: patch.sessionTarget as "main" | "isolated" }
      : {}),
    ...(typeof patch.conversationId === "string"
      ? { conversationId: patch.conversationId }
      : {}),
    ...(typeof patch.description === "string" ? { description: patch.description } : {}),
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
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
