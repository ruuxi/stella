import type { ToolResult } from "../tools/types.js";

/**
 * Shared per-tool inactivity bound for Stella tools bridged into external
 * engines (Claude Code takeover mode, Codex app-server). Mirrors the
 * agent-core loop's bound for the native engine: a tool that emits no
 * progress update for the window is cancelled via a composed abort signal
 * and reported to the engine as an error tool result, so the turn continues
 * instead of hanging forever on a tool that will never return (observed in
 * the field: a Recall call stalled on an unbounded network await held an
 * orchestrator turn — and with it the whole conversation — indefinitely).
 *
 * Ten minutes of total tool silence almost always means stuck; since only
 * the tool dies (the engine gets an error result and the turn continues),
 * a rare false positive is cheap and the bound errs tight.
 *
 * Shares `STELLA_TOOL_INACTIVITY_TIMEOUT_MS` with the native path; <= 0
 * disables the bound.
 */
export const DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

const configuredInactivityTimeoutMs = (): number => {
  const raw = process.env.STELLA_TOOL_INACTIVITY_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed)
    ? parsed
    : DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS;
};

/**
 * Run one bridged tool call under the inactivity bound.
 *
 * `run` receives the composed abort signal (outer signal + inactivity
 * cancellation) and an `onActivity` callback the caller must invoke on every
 * tool progress update to reset the clock. On timeout the composed signal
 * aborts (so a cooperative tool cleans up), and the call resolves with an
 * error ToolResult even if the tool's promise never settles.
 */
export const executeToolWithInactivityBound = async (args: {
  toolName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  run: (
    signal: AbortSignal | undefined,
    onActivity: () => void,
  ) => Promise<ToolResult>;
}): Promise<ToolResult> => {
  const timeoutMs = args.timeoutMs ?? configuredInactivityTimeoutMs();
  const toolAbort = new AbortController();
  const onOuterAbort = () => toolAbort.abort(args.signal?.reason);
  if (args.signal?.aborted) onOuterAbort();
  args.signal?.addEventListener("abort", onOuterAbort);
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let rejectOnInactivity: (error: Error) => void = () => {};
  const inactivityFailure = new Promise<never>((_, reject) => {
    rejectOnInactivity = reject;
  });
  inactivityFailure.catch(() => undefined);
  const armInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      const error = new Error(
        `Tool ${args.toolName} produced no output for ${Math.round(timeoutMs / 1000)}s and was cancelled. The agent may retry or continue without it.`,
      );
      toolAbort.abort(error);
      rejectOnInactivity(error);
    }, timeoutMs);
    inactivityTimer.unref?.();
  };
  armInactivityTimer();

  try {
    return await Promise.race([
      args.run(toolAbort.signal, () => {
        if (!timedOut) armInactivityTimer();
      }),
      inactivityFailure,
    ]);
  } catch (error) {
    if (timedOut) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    args.signal?.removeEventListener("abort", onOuterAbort);
  }
};
