/**
 * Per-thread background compaction scheduler.
 *
 * Keeps compaction off the user-visible finalize path. Each thread gets at
 * most one active run and one queued follow-up, which bounds stale history
 * without letting back-to-back turns spawn unbounded summary work.
 */

import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("compaction-scheduler");

export type CompactionScheduleArgs = {
  threadKey: string;
  /** Idempotent work; coalescing may drop this callback in favor of a queued one. */
  run: () => Promise<void>;
  /** Invoked after a successful run; coalesced callbacks all fire in order. */
  onSuccess?: () => void;
};

type QueuedSlot = {
  promise: Promise<void>;
  args: CompactionScheduleArgs;
  onSuccessChain: Array<() => void>;
  resolve: () => void;
};

type ThreadEntry = {
  active: Promise<void>;
  pending?: QueuedSlot;
};

export class BackgroundCompactionScheduler {
  private readonly threads = new Map<string, ThreadEntry>();

  schedule(args: CompactionScheduleArgs): Promise<void> {
    const existing = this.threads.get(args.threadKey);

    if (!existing) {
      const onSuccessChain: Array<() => void> = args.onSuccess
        ? [args.onSuccess]
        : [];
      const active = this.runActive(args, onSuccessChain);
      this.threads.set(args.threadKey, { active });
      return active;
    }

    if (!existing.pending) {
      const onSuccessChain: Array<() => void> = args.onSuccess
        ? [args.onSuccess]
        : [];
      let resolveOuter: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        resolveOuter = resolve;
      });
      existing.pending = {
        promise,
        args,
        onSuccessChain,
        resolve: resolveOuter,
      };
      logger.debug("compaction.queued-followup", {
        threadKey: args.threadKey,
      });
      return promise;
    }

    if (args.onSuccess) {
      existing.pending.onSuccessChain.push(args.onSuccess);
    }
    logger.debug("compaction.coalesced-into-pending", {
      threadKey: args.threadKey,
      onSuccessChainLength: existing.pending.onSuccessChain.length,
    });
    return existing.pending.promise;
  }

  private runActive(
    args: CompactionScheduleArgs,
    onSuccessChain: Array<() => void>,
  ): Promise<void> {
    const ownThreadKey = args.threadKey;
    const promise = this.executeRun(args, onSuccessChain).finally(() => {
      const entry = this.threads.get(ownThreadKey);
      if (!entry) return;
      if (entry.pending) {
        const nextSlot = entry.pending;
        entry.pending = undefined;
        const nextActive = this.executeRun(
          nextSlot.args,
          nextSlot.onSuccessChain,
        ).finally(() => {
          nextSlot.resolve();
          this.advanceAfter(ownThreadKey, nextActive);
        });
        entry.active = nextActive;
        return;
      }
      this.threads.delete(ownThreadKey);
    });
    return promise;
  }

  private advanceAfter(threadKey: string, currentActive: Promise<void>): void {
    const entry = this.threads.get(threadKey);
    if (!entry || entry.active !== currentActive) return;
    if (entry.pending) {
      const nextSlot = entry.pending;
      entry.pending = undefined;
      const nextActive = this.executeRun(
        nextSlot.args,
        nextSlot.onSuccessChain,
      ).finally(() => {
        nextSlot.resolve();
        this.advanceAfter(threadKey, nextActive);
      });
      entry.active = nextActive;
      return;
    }
    this.threads.delete(threadKey);
  }

  private async executeRun(
    args: CompactionScheduleArgs,
    onSuccessChain: Array<() => void>,
  ): Promise<void> {
    try {
      await args.run();
      for (const cb of onSuccessChain) {
        try {
          cb();
        } catch (error) {
          logger.warn("compaction.on-success-failed", {
            threadKey: args.threadKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn("compaction.background-failed", {
        threadKey: args.threadKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Currently in-flight compaction for `threadKey`, if any. */
  pending(threadKey: string): Promise<void> | null {
    return this.threads.get(threadKey)?.active ?? null;
  }

  /** Wait for every active and queued compaction to settle before shutdown. */
  async drain(): Promise<void> {
    while (this.threads.size > 0) {
      const promises: Array<Promise<void>> = [];
      for (const entry of this.threads.values()) {
        promises.push(entry.active);
        if (entry.pending) promises.push(entry.pending.promise);
      }
      await Promise.allSettled(promises);
    }
  }
}
