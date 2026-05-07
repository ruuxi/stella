import { buildRunThreadKey } from "./thread-memory.js";
import { createRunEventRecorder } from "./run-events.js";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorInterrupted,
  finalizeOrchestratorSuccess,
  finalizeSubagentError,
  finalizeSubagentInterrupted,
  finalizeSubagentSuccess,
} from "./run-completion.js";
import {
  createOrchestratorResponseTargetTracker,
  type OrchestratorResponseTargetTracker,
} from "./response-target.js";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";

/**
 * Engine-independent per-run state.
 *
 * External engines (Claude Code, future CLIs) own one of these because their
 * loop is provided by the engine binary, not the Pi `Agent`. Pi execution now
 * routes exclusively through long-lived `OrchestratorSession` /
 * `SubagentSession` instances.
 */
export type RuntimeExecutionSessionBase = {
  runId: string;
  threadKey: string;
  runEvents: ReturnType<typeof createRunEventRecorder>;
};

/**
 * Engine-agnostic finalize surface used by every run-flow caller. Both
 * external orchestrator/subagent paths get a session that satisfies this base.
 */
export type OrchestratorRunSessionBase = RuntimeExecutionSessionBase & {
  kind: "orchestrator";
  responseTargetTracker: OrchestratorResponseTargetTracker;
  finalizeSuccess: (finalText: string) => Promise<string>;
  finalizeError: (error: unknown) => string;
  finalizeInterrupted: (reason: string) => string;
};

export type ExternalOrchestratorRunSession = OrchestratorRunSessionBase;

export type SubagentRunSessionBase = RuntimeExecutionSessionBase & {
  kind: "subagent";
  finalizeSuccess: (finalText: string) => Promise<SubagentRunResult>;
  finalizeError: (error: unknown) => SubagentRunResult;
  finalizeInterrupted: (reason: string) => SubagentRunResult;
};

export type ExternalSubagentRunSession = SubagentRunSessionBase;

/**
 * External-engine orchestrator session (Claude Code, etc.).
 *
 * Builds `runEvents` + threadKey + response-target tracker the same way the
 * Pi factory does, and binds the same finalize helpers. Skips Pi-only
 * fields (`agent`, `tools`) because the engine loop is provided by the
 * external binary, not by the Pi `Agent`. The internal `agent` stub passed
 * to `finalizeOrchestratorSuccess` carries an empty messages array for
 * `before_compact`'s message-count payload — same behavior as the prior
 * inline call site in `external-engines.ts`.
 */
const EMPTY_AGENT_STUB = {
  state: { messages: [] as never[] },
} as const;

export const createExternalOrchestratorRunSession = (
  opts: OrchestratorRunOptions,
  args: { runId: string },
): ExternalOrchestratorRunSession => {
  const { runId } = args;
  const threadKey = buildRunThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  const responseTargetTracker = createOrchestratorResponseTargetTracker(
    opts.responseTarget,
  );
  const runEvents = createRunEventRecorder({
    store: opts.store,
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    userMessageId: opts.userMessageId,
    uiVisibility: opts.uiVisibility,
    getResponseTarget: () =>
      responseTargetTracker.resolve() ?? opts.responseTarget,
  });
  return {
    kind: "orchestrator",
    runId,
    threadKey,
    runEvents,
    responseTargetTracker,
    async finalizeSuccess(finalText: string): Promise<string> {
      await finalizeOrchestratorSuccess({
        opts,
        runId,
        threadKey,
        runEvents,
        agent: EMPTY_AGENT_STUB,
        finalText,
        responseTarget: responseTargetTracker.resolve(),
      });
      return runId;
    },
    finalizeError(error: unknown): string {
      finalizeOrchestratorError({
        opts,
        runEvents,
        error,
        runId,
        threadKey,
      });
      return runId;
    },
    finalizeInterrupted(reason: string): string {
      finalizeOrchestratorInterrupted({
        opts,
        runEvents,
        reason,
        runId,
        threadKey,
      });
      return runId;
    },
  };
};

/**
 * External-engine subagent session. Same shape as the Pi subagent factory
 * minus the `agent`/`tools` Pi-only fields.
 */
export const createExternalSubagentRunSession = (
  opts: SubagentRunOptions,
  args: { runId: string },
): ExternalSubagentRunSession => {
  const { runId } = args;
  const threadKey = buildRunThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  const runEvents = createRunEventRecorder({
    store: opts.store,
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    userMessageId: opts.userMessageId,
    uiVisibility: opts.uiVisibility,
    getResponseTarget: () => opts.responseTarget,
  });
  return {
    kind: "subagent",
    runId,
    threadKey,
    runEvents,
    async finalizeSuccess(finalText: string): Promise<SubagentRunResult> {
      return await finalizeSubagentSuccess({
        opts,
        runEvents,
        runId,
        threadKey,
        result: finalText,
      });
    },
    finalizeError(error: unknown): SubagentRunResult {
      return finalizeSubagentError({
        opts,
        runEvents,
        runId,
        error,
        threadKey,
      });
    },
    finalizeInterrupted(reason: string): SubagentRunResult {
      return finalizeSubagentInterrupted({
        opts,
        runEvents,
        runId,
        reason,
        threadKey,
      });
    },
  };
};
