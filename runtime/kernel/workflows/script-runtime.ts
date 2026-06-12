/**
 * Sandboxed execution for orchestrator-authored workflow scripts.
 *
 * The script runs inside a fresh `node:vm` context whose global object
 * carries ONLY standard ECMAScript builtins (Object, Array, JSON, Math,
 * Promise, …) plus the four workflow primitives — no `require`, no
 * `process`, no timers, no filesystem. The sandbox is a determinism and
 * API boundary, not a security boundary: the agents the script spawns
 * already have full machine access, so hardening the 20-line
 * orchestration above the agents it drives would be theater.
 *
 * Known limitation: `vm` timeouts only cover the initial synchronous
 * execution span. A pathological `while (true) {}` inside an async
 * continuation would block the worker thread — accepted under Stella's
 * trust model (the same model already authors self-mod code that runs
 * fully in-process).
 */

import vm from "node:vm";

export type WorkflowAgentOptions = {
  label?: string;
  schema?: Record<string, unknown>;
};

export type WorkflowAgentCall = (
  prompt: string,
  opts?: WorkflowAgentOptions,
) => Promise<unknown>;

const SYNC_EXECUTION_TIMEOUT_MS = 10_000;
const MAX_LOG_LINE_CHARS = 300;

export class WorkflowScriptSyntaxError extends Error {}

/**
 * Compile-check a script without running it. Throws
 * `WorkflowScriptSyntaxError` with the V8 message (line info included)
 * so the run_workflow tool can reject bad scripts synchronously.
 */
export const assertWorkflowScriptParses = (script: string): void => {
  try {
    new vm.Script(wrapScript(script), { filename: "stella-workflow.js" });
  } catch (error) {
    const err = error as Error;
    // V8 puts the offending source line, caret, and position on the
    // STACK of a vm SyntaxError, not the message — include its head so
    // the orchestrator can locate and fix the script.
    const stackHead = err.stack
      ?.split("\n")
      .slice(0, 4)
      .join("\n")
      .trim();
    throw new WorkflowScriptSyntaxError(
      `Workflow script has a syntax error: ${err.message}${stackHead ? `\n${stackHead}` : ""}`,
    );
  }
};

// Wrapping in an async IIFE gives scripts top-level `await` and
// top-level `return` (the returned value is the workflow result).
const wrapScript = (script: string): string =>
  `(async () => { "use strict";\n${script}\n})()`;

const createConcurrencyGate = (maxConcurrent: number) => {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};

export type RunWorkflowScriptArgs = {
  script: string;
  agent: WorkflowAgentCall;
  log: (message: string) => void;
  signal: AbortSignal;
  maxConcurrentAgents: number;
};

/**
 * Run a workflow script to completion and return its `return` value.
 * Rejections from the script (including agent() failures the script
 * didn't catch) propagate to the caller. Cancellation rejects promptly
 * via the signal race; in-flight agents are aborted by the caller's
 * controller.
 */
export const runWorkflowScript = async (
  args: RunWorkflowScriptArgs,
): Promise<unknown> => {
  const gate = createConcurrencyGate(Math.max(1, args.maxConcurrentAgents));

  const agent: WorkflowAgentCall = (prompt, opts) => {
    if (args.signal.aborted) {
      return Promise.reject(new Error("Workflow was canceled."));
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      return Promise.reject(
        new Error("agent() requires a non-empty prompt string."),
      );
    }
    const safeOpts: WorkflowAgentOptions = {};
    if (opts && typeof opts === "object") {
      if (typeof opts.label === "string" && opts.label.trim()) {
        safeOpts.label = opts.label.trim().slice(0, 80);
      }
      if (
        opts.schema &&
        typeof opts.schema === "object" &&
        !Array.isArray(opts.schema)
      ) {
        safeOpts.schema = opts.schema;
      }
    }
    return gate(() => {
      // Re-check after the gate: the workflow may have been canceled
      // while this call queued behind the concurrency cap.
      if (args.signal.aborted) {
        return Promise.reject(new Error("Workflow was canceled."));
      }
      return args.agent(prompt, safeOpts);
    });
  };

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel() takes an array of zero-arg functions.");
    }
    return await Promise.all(
      thunks.map(async (thunk) => {
        if (typeof thunk !== "function") return null;
        try {
          return await (thunk as () => Promise<unknown>)();
        } catch {
          // A failed branch resolves to null instead of rejecting the
          // whole fan-out — scripts filter with .filter(Boolean).
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown,
    ...stages: unknown[]
  ): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw new Error("pipeline() takes an array of items as its first argument.");
    }
    return await Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          if (typeof stage !== "function") continue;
          try {
            value = await (
              stage as (
                previous: unknown,
                original: unknown,
                index: number,
              ) => Promise<unknown>
            )(value, item, index);
          } catch {
            // A stage that throws drops the item to null and skips its
            // remaining stages.
            return null;
          }
        }
        return value;
      }),
    );
  };

  const log = (message: unknown): void => {
    if (typeof message !== "string") return;
    const trimmed = message.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    args.log(trimmed.slice(0, MAX_LOG_LINE_CHARS));
  };

  const sandbox = vm.createContext(
    { agent, parallel, pipeline, log },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const compiled = new vm.Script(wrapScript(args.script), {
    filename: "stella-workflow.js",
  });
  const scriptPromise = compiled.runInContext(sandbox, {
    timeout: SYNC_EXECUTION_TIMEOUT_MS,
  }) as Promise<unknown>;

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(new Error("Workflow was canceled."));
    if (args.signal.aborted) {
      onAbort();
      return;
    }
    args.signal.addEventListener("abort", onAbort, { once: true });
  });

  return await Promise.race([scriptPromise, abortPromise]);
};
