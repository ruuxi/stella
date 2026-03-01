import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type ClaimFlowTable = "cron_jobs" | "heartbeat_configs";

export const DEFAULT_STUCK_RUN_MS = 2 * 60 * 60 * 1000;

export type ClaimFlowBuildContext = {
  nowMs: number;
  expectedRunningAtMs: number | undefined;
};

const toRunningAtMs = (runningAtMs: unknown): number | undefined =>
  typeof runningAtMs === "number" ? runningAtMs : undefined;

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
