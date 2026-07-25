/**
 * `WakeWhen` / `WakeCancel` — the durable way to wait on a long external
 * event across turn boundaries.
 *
 * The problem this exists to solve: an agent's turn is the only place its
 * own code runs. Background children it spawns (a `nohup`'d monitor, a
 * watcher shell, a `sleep && notify` chain) do keep running after the turn
 * ends — Stella's shells are worker-lifetime resources — but nothing they
 * print can start a new turn. There is no path from a process the agent
 * spawned back into the thread. So an agent that ends its turn saying
 * "I'll report back when the job lands" is never resumed, and the thread
 * sits idle forever while whatever it was waiting on bills by the hour.
 *
 * `WakeWhen` registers the wait with the runtime instead: a condition-gated
 * cron job owned by `LocalSchedulerService`, which lives in the host
 * process and persists its state to disk. It outlives the turn, the engine
 * CLI session, the worker, and an app restart. When the condition command
 * exits 0 the scheduler delivers the follow-up straight back into the
 * arming thread (`send_input`, so the agent keeps its own history), or as a
 * fresh turn on the conversation when there is no thread to resume.
 *
 * Every wake carries a deadline. A wait that never comes true still fires,
 * flagged as expired, so the thread always gets control back.
 */

import type { ScheduleToolApi, ToolContext, ToolResult } from "./types.js";

/** Floor on the poll rate. Each check is a real process spawn. */
const MIN_POLL_SECONDS = 10;
/** Ceiling on the poll rate — past this a wake feels like it never fired. */
const MAX_POLL_SECONDS = 30 * 60;
const DEFAULT_POLL_SECONDS = 30;

/**
 * Default deadline. Long enough for a build, a training run, or a remote
 * job queue; short enough that a forgotten wake doesn't linger for days.
 */
const DEFAULT_TIMEOUT_MINUTES = 60;
const MAX_TIMEOUT_MINUTES = 24 * 60;

const requireScheduleApi = (scheduleApi?: ScheduleToolApi): ScheduleToolApi => {
  if (!scheduleApi) {
    throw new Error("Scheduling is not configured on this device.");
  }
  return scheduleApi;
};

const asTrimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const clampNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const describeDeadline = (expiresAtMs: number): string => {
  const minutes = Math.round((expiresAtMs - Date.now()) / 60_000);
  return minutes < 90 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
};

export const handleWakeWhen = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const when = asTrimmed(args.when);
  if (!when) {
    return {
      error:
        "`when` is required: a shell command that exits 0 once the thing you are waiting for has happened.",
    };
  }
  const then = asTrimmed(args.then);
  if (!then) {
    return {
      error:
        "`then` is required: the instructions you want handed back to yourself when the wake fires.",
    };
  }

  const pollSeconds = clampNumber(
    args.pollSeconds,
    DEFAULT_POLL_SECONDS,
    MIN_POLL_SECONDS,
    MAX_POLL_SECONDS,
  );
  const timeoutMinutes = clampNumber(
    args.timeoutMinutes,
    DEFAULT_TIMEOUT_MINUTES,
    1,
    MAX_TIMEOUT_MINUTES,
  );
  const expiresAtMs = Date.now() + timeoutMinutes * 60_000;
  const cwd = asTrimmed(args.cwd) || asTrimmed(context.toolWorkspaceRoot);
  const name =
    asTrimmed(args.name) ||
    `Wake: ${when.length > 60 ? `${when.slice(0, 59)}…` : when}`;

  const record = await api.addCronJob({
    name,
    conversationId: context.conversationId,
    schedule: { kind: "every", everyMs: pollSeconds * 1000 },
    condition: { kind: "command", command: when, ...(cwd ? { cwd } : {}) },
    expiresAtMs,
    payload: {
      kind: "agent",
      prompt: then,
      ...(context.agentType ? { agentType: context.agentType } : {}),
      // `agentId` is this agent's own durable thread id. Naming it means the
      // wake resumes THIS thread with its history rather than starting a
      // stranger who only knows `then`.
      ...(context.agentId ? { threadId: context.agentId } : {}),
    },
    // A wake is a one-shot: the scheduler retires conditional jobs once
    // they fire, and deleting keeps `CronList` free of spent watchers.
    deleteAfterRun: true,
    // The wake's own fire is the delivery. Suppressing the assistant
    // message keeps a background wait out of the user's chat unless the
    // resumed agent actually has something to say.
    deliver: false,
  });

  return {
    result: [
      `Wake armed (${record.id}).`,
      `Checking \`${when}\` every ${pollSeconds}s; gives up in ${describeDeadline(expiresAtMs)} and wakes you anyway.`,
      "You can end your turn now — the runtime owns this wait, not your session.",
    ].join("\n"),
    details: { wakeId: record.id, expiresAtMs, pollSeconds },
  };
};

export const handleWakeCancel = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const wakeId = asTrimmed(args.wakeId);
  if (!wakeId) {
    return { error: "`wakeId` is required (returned by WakeWhen)." };
  }
  const removed = await api.removeCronJob(wakeId);
  return {
    result: removed
      ? `Wake ${wakeId} canceled.`
      : `No wake found with id ${wakeId} (it may have already fired).`,
  };
};
