import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOptionalInt } from "../lib/number_utils";

type ClaimFlowTable = "cron_jobs" | "heartbeat_configs";

const DEFAULT_DUE_LIMIT = 50;
const MAX_DUE_LIMIT = 200;
const DEFAULT_TICK_LIMIT = 200;

export const DEFAULT_STUCK_RUN_MS = 2 * 60 * 60 * 1000;

export type ClaimFlowBuildContext = {
  nowMs: number;
  expectedRunningAtMs: number | undefined;
};

type ClaimFlowRecord = {
  _id: Id<ClaimFlowTable>;
  enabled: boolean;
  runningAtMs?: number;
};

const toRunningAtMs = (runningAtMs: unknown): number | undefined =>
  typeof runningAtMs === "number" ? runningAtMs : undefined;

export function listDueByNextRunAtMs(
  ctx: QueryCtx,
  args: {
    table: "cron_jobs";
    nowMs: number;
    limit?: number;
  },
): Promise<Doc<"cron_jobs">[]>;
export function listDueByNextRunAtMs(
  ctx: QueryCtx,
  args: {
    table: "heartbeat_configs";
    nowMs: number;
    limit?: number;
  },
): Promise<Doc<"heartbeat_configs">[]>;
export async function listDueByNextRunAtMs(
  ctx: QueryCtx,
  args: {
    table: ClaimFlowTable;
    nowMs: number;
    limit?: number;
  },
) {
  const limit = normalizeOptionalInt({
    value: args.limit,
    defaultValue: DEFAULT_DUE_LIMIT,
    min: 1,
    max: MAX_DUE_LIMIT,
  });
  if (args.table === "cron_jobs") {
    return await ctx.db
      .query("cron_jobs")
      .withIndex("by_nextRunAtMs_and_ownerId", (q) => q.lte("nextRunAtMs", args.nowMs))
      .take(limit);
  }
  return await ctx.db
    .query("heartbeat_configs")
    .withIndex("by_nextRunAtMs_and_ownerId", (q) => q.lte("nextRunAtMs", args.nowMs))
    .take(limit);
}

export const claimRunIfAvailable = async <TableName extends ClaimFlowTable>(args: {
  ctx: MutationCtx;
  table: TableName;
  id: Id<TableName>;
  runningAtMs: number;
  expectedRunningAtMs?: number;
  patch?: Partial<Doc<TableName>>;
  stuckRunMs?: number;
}) => {
  const record = await args.ctx.db.get(args.id);
  if (!record || !record.enabled) {
    return false;
  }
  const currentRunningAtMs = toRunningAtMs(record.runningAtMs);
  if (currentRunningAtMs !== args.expectedRunningAtMs) {
    return false;
  }
  const stuckRunMs = args.stuckRunMs ?? DEFAULT_STUCK_RUN_MS;
  if (
    typeof currentRunningAtMs === "number" &&
    args.runningAtMs - currentRunningAtMs < stuckRunMs
  ) {
    return false;
  }
  await args.ctx.db.patch(args.id, {
    ...args.patch,
    runningAtMs: args.runningAtMs,
    updatedAt: Date.now(),
  } as Partial<Doc<TableName>>);
  return true;
};

export const claimAndScheduleDueRuns = async <
  RecordType extends ClaimFlowRecord,
  ClaimArgs,
>(args: {
  nowMs: number;
  listDue: (args: { nowMs: number; limit: number }) => Promise<RecordType[]>;
  markRunning: (args: ClaimArgs) => Promise<boolean>;
  buildClaimArgs: (
    record: RecordType,
    context: ClaimFlowBuildContext,
  ) => ClaimArgs;
  schedule: (record: RecordType) => Promise<unknown> | unknown;
  limit?: number;
  stuckRunMs?: number;
}) => {
  const stuckRunMs = args.stuckRunMs ?? DEFAULT_STUCK_RUN_MS;
  const due = await args.listDue({
    nowMs: args.nowMs,
    limit: args.limit ?? DEFAULT_TICK_LIMIT,
  });

  for (const record of due) {
    if (!record.enabled) {
      continue;
    }
    const expectedRunningAtMs = toRunningAtMs(record.runningAtMs);
    if (
      typeof expectedRunningAtMs === "number" &&
      args.nowMs - expectedRunningAtMs < stuckRunMs
    ) {
      continue;
    }
    const claimed = await args.markRunning(
      args.buildClaimArgs(record, {
        nowMs: args.nowMs,
        expectedRunningAtMs,
      }),
    );
    if (!claimed) {
      continue;
    }
    await args.schedule(record);
  }
};

export const claimAndScheduleSingleRun = async <
  RecordType extends { runningAtMs?: number },
  ClaimArgs,
>(args: {
  nowMs: number;
  record: RecordType;
  markRunning: (args: ClaimArgs) => Promise<boolean>;
  buildClaimArgs: (
    record: RecordType,
    context: ClaimFlowBuildContext,
  ) => ClaimArgs;
  schedule: (record: RecordType) => Promise<unknown> | unknown;
}) => {
  const claimed = await args.markRunning(
    args.buildClaimArgs(args.record, {
      nowMs: args.nowMs,
      expectedRunningAtMs: toRunningAtMs(args.record.runningAtMs),
    }),
  );
  if (!claimed) {
    return false;
  }
  await args.schedule(args.record);
  return true;
};
