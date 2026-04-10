type QueuedRunActivation =
  | { action: "drop" }
  | { action: "backfill" }
  | { action: "wait" }
  | { action: "activate" };

export function resolveQueuedRunActivation(args: {
  queuedRunId: string;
  activeRunId: string | null;
  terminalRunIds: ReadonlySet<string>;
}): QueuedRunActivation {
  if (args.terminalRunIds.has(args.queuedRunId)) {
    return { action: "drop" };
  }

  if (args.activeRunId === args.queuedRunId) {
    return { action: "backfill" };
  }

  if (args.activeRunId) {
    return { action: "wait" };
  }

  return { action: "activate" };
}
