import { describe, expect, it } from "vitest";
import { BackgroundCompactionScheduler } from "../../../../../runtime/kernel/agent-runtime/compaction-scheduler.js";

/**
 * Helper: a deferred Promise<void> with externally-resolvable controls.
 * Lets a test pause a scheduler `run` callback at a precise point and
 * then release it on demand, so the in-flight / queued / coalesced
 * states can be observed deterministically.
 */
const deferred = (): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} => {
  let resolve: () => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = (n = 1) =>
  new Promise<void>((resolve) => {
    let count = 0;
    const next = () => {
      count++;
      if (count >= n) {
        resolve();
        return;
      }
      queueMicrotask(next);
    };
    queueMicrotask(next);
  });

describe("BackgroundCompactionScheduler", () => {
  it("runs a single scheduled compaction and fires onSuccess", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    let ranA = false;
    let onSuccessA = false;

    const result = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        ranA = true;
      },
      onSuccess: () => {
        onSuccessA = true;
      },
    });

    await result;
    expect(ranA).toBe(true);
    expect(onSuccessA).toBe(true);
    expect(scheduler.pending("thread-1")).toBeNull();
  });

  it("queues a follow-up when a duplicate schedule arrives mid-flight", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    const gateA = deferred();
    const gateB = deferred();

    let aRan = false;
    let bRan = false;
    let aOk = false;
    let bOk = false;

    const promiseA = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        aRan = true;
        await gateA.promise;
      },
      onSuccess: () => {
        aOk = true;
      },
    });

    await tick();
    expect(aRan).toBe(true);
    expect(scheduler.pending("thread-1")).not.toBeNull();

    const promiseB = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        bRan = true;
        await gateB.promise;
      },
      onSuccess: () => {
        bOk = true;
      },
    });

    expect(bRan).toBe(false);
    expect(bOk).toBe(false);

    gateA.resolve();
    await promiseA;
    expect(aOk).toBe(true);

    // Observe promotion through the scheduler's pending slot, not microtask timing.
    const promotedActive = scheduler.pending("thread-1");
    expect(promotedActive).not.toBeNull();
    await tick(4);
    expect(bRan).toBe(true);
    expect(bOk).toBe(false);

    gateB.resolve();
    await promiseB;
    expect(bOk).toBe(true);
    expect(scheduler.pending("thread-1")).toBeNull();
  });

  it("coalesces a third schedule into the queued follow-up's onSuccess chain", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    const gateA = deferred();

    const aOk: number[] = [];
    const bOks: string[] = [];

    const promiseA = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        await gateA.promise;
      },
      onSuccess: () => {
        aOk.push(1);
      },
    });

    await tick();

    let bRanCount = 0;
    const promiseB = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        bRanCount++;
      },
      onSuccess: () => {
        bOks.push("first");
      },
    });

    // Coalesced callers share the queued run, but each onSuccess must fire.
    const promiseC = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        bRanCount++;
      },
      onSuccess: () => {
        bOks.push("coalesced");
      },
    });

    gateA.resolve();
    await promiseA;
    await promiseB;
    await promiseC;

    expect(aOk).toEqual([1]);
    expect(bRanCount).toBe(1);
    expect(bOks).toEqual(["first", "coalesced"]);
  });

  it("isolates separate threadKeys (no cross-thread coalescing)", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    const gate1 = deferred();
    const gate2 = deferred();

    let ran1 = false;
    let ran2 = false;

    const p1 = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        ran1 = true;
        await gate1.promise;
      },
    });
    const p2 = scheduler.schedule({
      threadKey: "thread-2",
      run: async () => {
        ran2 = true;
        await gate2.promise;
      },
    });

    await tick();
    expect(ran1).toBe(true);
    expect(ran2).toBe(true);

    gate1.resolve();
    gate2.resolve();
    await p1;
    await p2;
  });

  it("logs (does not throw) when run() throws and does NOT fire onSuccess", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    let onSuccessCalled = false;

    await scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        throw new Error("boom");
      },
      onSuccess: () => {
        onSuccessCalled = true;
      },
    });

    expect(onSuccessCalled).toBe(false);
    expect(scheduler.pending("thread-1")).toBeNull();
  });

  it("runs subsequent schedules after a failed run completes", async () => {
    const scheduler = new BackgroundCompactionScheduler();

    await scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        throw new Error("boom");
      },
    });

    let ranSecond = false;
    await scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        ranSecond = true;
      },
    });
    expect(ranSecond).toBe(true);
  });

  it("drain() resolves only after every active + queued slot settles", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    const gateA = deferred();
    const gateB = deferred();

    const _aPromise = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        await gateA.promise;
      },
    });
    void _aPromise;

    const _bPromise = scheduler.schedule({
      threadKey: "thread-1",
      run: async () => {
        await gateB.promise;
      },
    });
    void _bPromise;

    let drained = false;
    const drainPromise = scheduler.drain().then(() => {
      drained = true;
    });

    await tick(2);
    expect(drained).toBe(false);

    gateA.resolve();
    await tick(2);
    expect(drained).toBe(false); // B still queued

    gateB.resolve();
    await drainPromise;
    expect(drained).toBe(true);
    expect(scheduler.pending("thread-1")).toBeNull();
  });
});
