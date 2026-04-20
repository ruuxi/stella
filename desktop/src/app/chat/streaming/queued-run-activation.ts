export type QueuedRunActivationDecision =
  | { action: "drop" }
  | { action: "backfill" }
  | { action: "wait" }
  | { action: "activate" };

export const resolveQueuedRunActivation = (args: {
  queuedRunId: string | null;
  activeRunId: string | null;
  terminalRunIds: ReadonlySet<string>;
}): QueuedRunActivationDecision => {
  if (!args.queuedRunId || args.terminalRunIds.has(args.queuedRunId)) {
    return { action: "drop" };
  }
  if (args.activeRunId === args.queuedRunId) {
    return { action: "backfill" };
  }
  if (args.activeRunId) {
    return { action: "wait" };
  }
  return { action: "activate" };
};
