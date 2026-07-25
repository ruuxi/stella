/**
 * Automatic wake on background command exit.
 *
 * An agent's turn is the only place its own code runs. `exec_command`
 * sessions deliberately outlive the run that started them (see the
 * teardown comment in `tools/host.ts`), so a build, benchmark, or training
 * job the agent left running keeps running after the turn ends — but
 * nothing it prints can start a new turn. The thread just stops, and the
 * work finishes into a void. That is how a GPU pod once idle-billed for
 * hours against a monitor whose output nobody read.
 *
 * So the runtime watches instead of asking the agent to. When a run ends
 * with sessions it started still alive, we attach exit watchers here. When
 * they exit, the exits are coalesced into one message and delivered to the
 * owning thread through the same `send_input` path a human or the
 * orchestrator would use — which rehydrates an evicted or finished thread
 * with its full history. The agent picks up where it left off, holding the
 * command, its exit code, and its output.
 *
 * Borrowed from Codex's session model: a "durably asleep" thread is one
 * that ended with work outstanding, and only such a thread is woken by
 * incoming mail. Here the arm IS the sleep marker — it is set at teardown
 * and replaced or dropped whenever the thread runs again, so a thread that
 * has already moved on is never woken by a stale exit.
 */

import fs from "node:fs";
import path from "node:path";

import type { ShellExitSnapshot } from "../tools/shell.js";

const EXIT_LOG_DIRNAME = "background-exits";
/** Spilled logs are a debugging aid for one wake, not an archive. */
const EXIT_LOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long to hold the first exit before delivering, waiting for siblings.
 * `make -j` style fan-out and `wait`-ed pipelines land within a few hundred
 * ms of each other; one wake carrying four results is worth far more than
 * four turns carrying one each.
 */
const COALESCE_WINDOW_MS = 2_000;

/**
 * Ceiling on the coalescing window. Without it a session exiting every
 * 1.9s could defer the wake indefinitely.
 */
const MAX_COALESCE_MS = 15_000;

/** Inline output budget per exited command, before the log file takes over. */
const INLINE_OUTPUT_CHARS = 2_000;

/**
 * Head/tail split for a command whose output exceeds the inline budget.
 * Weighted toward the tail — the failure is usually at the end — but the
 * head is kept because that is where the command says what it is doing.
 * Adopted from Codex's middle-truncation policy, which keeps both ends
 * rather than Stella's usual tail-only shell drain.
 */
const HEAD_SHARE = 0.3;

export type BackgroundExitWakeDeps = {
  watchShellExit: (sessionId: string, listener: () => void) => () => void;
  readShellExitSnapshot: (sessionId: string) => ShellExitSnapshot | null;
  /**
   * Deliver the wake into the owning thread. Returns whether it landed;
   * `false` means the thread refused it (canceled, a workflow, gone) and
   * the arm should simply be dropped.
   */
  deliver: (wake: {
    conversationId: string;
    agentId: string;
    text: string;
  }) => Promise<boolean>;
  /**
   * Current lifecycle status of a thread, when known. A canceled thread is
   * one the user explicitly stopped; a late exit must not resurrect it.
   */
  getThreadStatus?: (
    agentId: string,
  ) => Promise<string | undefined> | string | undefined;
  /** Where to spill output too large to inline. */
  writeExitLog?: (
    sessionId: string,
    contents: string,
  ) => Promise<string | null> | string | null;
  now?: () => number;
};

type ArmedThread = {
  conversationId: string;
  agentId: string;
  disposers: Map<string, () => void>;
  collected: ShellExitSnapshot[];
  timer: ReturnType<typeof setTimeout> | null;
  firstExitAt: number | null;
};

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
};

/**
 * Keep the head and the tail, drop the middle. A truncation notice sits at
 * the seam so the agent can tell missing output from short output.
 */
export const truncateMiddle = (
  value: string,
  max: number = INLINE_OUTPUT_CHARS,
): string => {
  if (value.length <= max) return value;
  const headChars = Math.floor(max * HEAD_SHARE);
  const tailChars = max - headChars;
  const dropped = value.length - max;
  return [
    value.slice(0, headChars),
    `\n… [${dropped} characters omitted] …\n`,
    value.slice(value.length - tailChars),
  ].join("");
};

const describeExit = (
  exit: ShellExitSnapshot,
  logPath: string | null,
): string => {
  const outcome =
    exit.exitCode === 0
      ? "succeeded"
      : exit.exitCode === null
        ? "ended without an exit code"
        : `failed with exit code ${exit.exitCode}`;
  const lines = [
    `$ ${exit.command}`,
    `  ${outcome} after ${formatDuration(exit.completedAt - exit.startedAt)} (cwd: ${exit.cwd})`,
  ];
  const output = exit.output.trim();
  if (!output) {
    lines.push("  (no output captured)");
    return lines.join("\n");
  }
  lines.push("", truncateMiddle(output));
  if (output.length > INLINE_OUTPUT_CHARS && logPath) {
    lines.push("", `Full captured output: ${logPath}`);
  }
  return lines.join("\n");
};

const buildWakeText = (
  exits: ShellExitSnapshot[],
  logPaths: Map<string, string | null>,
): string => {
  const header =
    exits.length === 1
      ? "[wake: a command you left running in the background has finished.]"
      : `[wake: ${exits.length} commands you left running in the background have finished.]`;
  return [
    header,
    "",
    ...exits.map((exit) =>
      describeExit(exit, logPaths.get(exit.sessionId) ?? null),
    ),
    "",
    "You were resumed for this. Continue the work that was waiting on it, or say what you found.",
  ].join("\n");
};

/**
 * Spill a command's captured output so the wake can cite a path instead of
 * inlining tens of kilobytes. Unlike a tool result, a wake is a one-shot
 * injection — the agent can't ask for the rest — so the rest has to live
 * somewhere it can read. Codex has no equivalent because its model always
 * re-polls for output; ours only gets told once.
 */
export const writeBackgroundExitLog = (
  stellaDataDir: string,
  sessionId: string,
  contents: string,
): string | null => {
  try {
    const dir = path.join(stellaDataDir, EXIT_LOG_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - EXIT_LOG_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      const stale = path.join(dir, name);
      try {
        if (fs.statSync(stale).mtimeMs < cutoff)
          fs.rmSync(stale, { force: true });
      } catch {
        // A file that vanished under us needs no pruning.
      }
    }
    const logPath = path.join(dir, `${sessionId}.log`);
    fs.writeFileSync(logPath, contents, "utf-8");
    return logPath;
  } catch {
    // Losing the spill only costs detail; the wake still carries head+tail.
    return null;
  }
};

export const createBackgroundExitWake = (deps: BackgroundExitWakeDeps) => {
  const now = deps.now ?? (() => Date.now());
  const armed = new Map<string, ArmedThread>();

  const disarm = (agentId: string) => {
    const entry = armed.get(agentId);
    if (!entry) return;
    for (const dispose of entry.disposers.values()) dispose();
    entry.disposers.clear();
    if (entry.timer) clearTimeout(entry.timer);
    armed.delete(agentId);
  };

  const flush = async (agentId: string) => {
    const entry = armed.get(agentId);
    if (!entry) return;
    const exits = entry.collected.splice(0);
    // Sessions still running keep their watchers; the arm survives until
    // every one of them has reported or the thread runs again.
    entry.timer = null;
    entry.firstExitAt = null;
    if (entry.disposers.size === 0) armed.delete(agentId);
    if (exits.length === 0) return;

    if (deps.getThreadStatus) {
      try {
        const status = await deps.getThreadStatus(agentId);
        if (status === "canceled") {
          // The user stopped this thread on purpose. Its leftovers finishing
          // is not a reason to start it up again.
          disarm(agentId);
          return;
        }
      } catch {
        // Status is an optimization; deliver rather than drop the wake.
      }
    }

    const logPaths = new Map<string, string | null>();
    for (const exit of exits) {
      if (exit.output.length <= INLINE_OUTPUT_CHARS || !deps.writeExitLog) {
        continue;
      }
      try {
        logPaths.set(
          exit.sessionId,
          await deps.writeExitLog(exit.sessionId, exit.output),
        );
      } catch {
        logPaths.set(exit.sessionId, null);
      }
    }

    try {
      const delivered = await deps.deliver({
        conversationId: entry.conversationId,
        agentId,
        text: buildWakeText(exits, logPaths),
      });
      if (!delivered) disarm(agentId);
    } catch (error) {
      console.warn(
        `[background-wake] failed to deliver exit wake to ${agentId}:`,
        (error as Error).message,
      );
    }
  };

  const scheduleFlush = (agentId: string) => {
    const entry = armed.get(agentId);
    if (!entry) return;
    const startedAt = entry.firstExitAt ?? now();
    entry.firstExitAt = startedAt;
    if (entry.timer) clearTimeout(entry.timer);
    // Extend for late siblings, but never past the ceiling measured from
    // the first exit.
    const remaining = Math.max(0, startedAt + MAX_COALESCE_MS - now());
    const delay = Math.min(COALESCE_WINDOW_MS, remaining);
    entry.timer = setTimeout(() => {
      void flush(agentId);
    }, delay);
    entry.timer.unref?.();
  };

  return {
    /**
     * Arm exit wakes for the sessions a finished run left running.
     *
     * Called once per run teardown. Re-arming replaces any previous arm for
     * the thread, which is what keeps a stale exit from waking a thread
     * that has already moved on.
     */
    arm: (args: {
      conversationId: string;
      agentId?: string;
      runningSessionIds: string[];
      /** Interrupted runs are not resumed: the user or runtime stopped them. */
      interrupted?: boolean;
    }): string[] => {
      const { agentId } = args;
      if (!agentId) {
        // No durable thread to resume — an orchestrator or one-shot caller.
        // Nothing to arm; the caller logs this case.
        return [];
      }
      disarm(agentId);
      if (args.interrupted || args.runningSessionIds.length === 0) return [];

      const entry: ArmedThread = {
        conversationId: args.conversationId,
        agentId,
        disposers: new Map(),
        collected: [],
        timer: null,
        firstExitAt: null,
      };
      armed.set(agentId, entry);

      for (const sessionId of args.runningSessionIds) {
        const dispose = deps.watchShellExit(sessionId, () => {
          const live = armed.get(agentId);
          if (live !== entry) return;
          entry.disposers.delete(sessionId);
          const snapshot = deps.readShellExitSnapshot(sessionId);
          if (snapshot) entry.collected.push(snapshot);
          scheduleFlush(agentId);
        });
        entry.disposers.set(sessionId, dispose);
      }
      return [...entry.disposers.keys()];
    },

    /** Drop a thread's arm — it is running again, so it can poll for itself. */
    disarm,

    /** Test seam: force any buffered exits out without waiting on the timer. */
    flushNow: flush,

    /** Test/diagnostic: threads currently waiting on a background exit. */
    armedThreadIds: () => [...armed.keys()],

    dispose: () => {
      for (const agentId of [...armed.keys()]) disarm(agentId);
    },
  };
};

export type BackgroundExitWake = ReturnType<typeof createBackgroundExitWake>;
