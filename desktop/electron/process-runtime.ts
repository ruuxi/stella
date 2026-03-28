import { execFileSync, type ChildProcess } from "node:child_process";

export type ProcessRuntimePhase = "before-quit" | "will-quit";

type CleanupFn = () => void | Promise<void>;

type TimerHandle = ReturnType<typeof setTimeout>;

export const stopChildProcessTree = async (
  child: ChildProcess | null | undefined,
  options: {
    graceSignal?: NodeJS.Signals;
    forceAfterMs?: number;
  } = {},
) => {
  const { graceSignal = "SIGTERM", forceAfterMs = 1_500 } = options;

  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      try {
        child.kill(graceSignal);
      } catch {
        return;
      }
    }
  } else {
    try {
      process.kill(-child.pid, graceSignal);
    } catch {
      try {
        child.kill(graceSignal);
      } catch {
        return;
      }
    }
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort forced cleanup.
        }
        resolve();
      }, forceAfterMs);
      timer.unref?.();
    }),
  ]).catch(() => undefined);
};

export class ProcessRuntime {
  private readonly cleanups: Record<ProcessRuntimePhase, Map<string, CleanupFn>> = {
    "before-quit": new Map(),
    "will-quit": new Map(),
  };

  private readonly timers = new Set<TimerHandle>();
  private readonly waitResolvers = new Set<() => void>();
  private readonly phaseRuns = new Map<ProcessRuntimePhase, Promise<void>>();
  private shuttingDown = false;

  isShuttingDown() {
    return this.shuttingDown;
  }

  registerCleanup(
    phase: ProcessRuntimePhase,
    key: string,
    cleanup: CleanupFn,
  ) {
    this.cleanups[phase].set(key, cleanup);
    return () => {
      this.cleanups[phase].delete(key);
    };
  }

  setManagedTimeout(callback: () => void, delayMs: number) {
    if (this.shuttingDown) {
      return () => undefined;
    }

    let timer: TimerHandle | null = null;
    timer = setTimeout(() => {
      if (timer) {
        this.timers.delete(timer);
      }
      if (this.shuttingDown) {
        return;
      }
      callback();
    }, delayMs);
    this.timers.add(timer);
    timer.unref?.();

    return () => {
      if (!timer) {
        return;
      }
      clearTimeout(timer);
      this.timers.delete(timer);
      timer = null;
    };
  }

  setManagedInterval(callback: () => void, delayMs: number) {
    if (this.shuttingDown) {
      return () => undefined;
    }

    const timer = setInterval(() => {
      if (this.shuttingDown) {
        return;
      }
      callback();
    }, delayMs);
    this.timers.add(timer);
    timer.unref?.();

    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }

  wait(delayMs: number) {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      let timer: TimerHandle | null = null;

      const finish = (completed: boolean) => {
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(timer);
          timer = null;
        }
        this.waitResolvers.delete(cancel);
        resolve(completed);
      };

      const cancel = () => {
        finish(false);
      };

      timer = setTimeout(() => {
        finish(!this.shuttingDown);
      }, delayMs);
      this.timers.add(timer);
      this.waitResolvers.add(cancel);
      timer.unref?.();
    });
  }

  async runPhase(phase: ProcessRuntimePhase) {
    const existingRun = this.phaseRuns.get(phase);
    if (existingRun) {
      return await existingRun;
    }

    if (phase === "before-quit") {
      this.shuttingDown = true;
      this.clearTimers();
    }

    const run = (async () => {
      for (const [key, cleanup] of [...this.cleanups[phase].entries()].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          console.error(`[process-runtime] Cleanup failed for ${phase}:${key}`, error);
        }
      }
    })();

    this.phaseRuns.set(phase, run);
    await run;
  }

  private clearTimers() {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
    for (const resolve of [...this.waitResolvers]) {
      resolve();
    }
    this.waitResolvers.clear();
  }
}
