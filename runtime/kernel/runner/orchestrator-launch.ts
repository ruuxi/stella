import crypto from "crypto";
import {
  runOrchestratorTurn,
  type RuntimeRunCallbacks,
} from "../agent-runtime.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { getOrCreateOrchestratorSession } from "../agent-runtime/orchestrator-session.js";
import {
  resolveRunnerLlmRoute,
  resolveRunnerLlmRouteWithMetadata,
} from "./model-selection.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import type { RunnerContext } from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import {
  agentControlsSelfModHmr,
  agentHasCapability,
} from "../../contracts/agent-runtime.js";
import { extractApplyPatchTargetPaths } from "../tools/apply-patch.js";
import { resolveToolPath } from "../tools/path-inference.js";
import { isKnownSafeCommand } from "../tools/safe-commands.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../../contracts/file-changes.js";

type BuildAgentContext = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
  toolWorkspaceRoot?: string;
}) => Promise<LocalAgentContext>;

const collectWrittenPaths = (
  records: ReadonlyArray<FileChangeRecord | ProducedFileRecord> | undefined,
): string[] => {
  if (!records || records.length === 0) return [];
  const out: string[] = [];
  for (const record of records) {
    if (typeof record.path === "string" && record.path.length > 0) {
      out.push(record.path);
    }
    if (record.kind.type === "update" && record.kind.move_path) {
      out.push(record.kind.move_path);
    }
  }
  return out;
};

const inferPreWritePaths = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): string[] => {
  if (toolName === "apply_patch") {
    const patch = String(args.input ?? args.patch ?? "").trim();
    if (!patch) return [];
    try {
      return extractApplyPatchTargetPaths(patch)
        .map((target) => resolveToolPath(target, args, context))
        .filter((target): target is string => Boolean(target));
    } catch {
      return [];
    }
  }

  if (
    toolName === "Write" ||
    toolName === "Edit" ||
    toolName === "StrReplace"
  ) {
    const resolved = resolveToolPath(args.file_path, args, context);
    return resolved ? [resolved] : [];
  }

  return [];
};

const getShellExecutionState = (
  result: ToolResult,
): { sessionId: string | null; running: boolean } | null => {
  const payload = result.details ?? result.result;
  if (typeof payload === "string") {
    const match = payload.match(/\bShell ID:\s*([^\s]+)/);
    if (match) {
      return { sessionId: match[1] ?? null, running: true };
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { session_id?: unknown; running?: unknown };
  if (typeof record.running !== "boolean") return null;
  return {
    sessionId: typeof record.session_id === "string" ? record.session_id : null,
    running: record.running,
  };
};

const normalizeNestedToolName = (raw: unknown): string => {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.startsWith("functions.")
    ? value.slice("functions.".length)
    : value;
};

const getParallelToolEntries = (
  args: Record<string, unknown>,
): Array<{ toolName: string; parameters: Record<string, unknown> }> => {
  if (!Array.isArray(args.tool_uses)) return [];
  const out: Array<{ toolName: string; parameters: Record<string, unknown> }> =
    [];
  for (const entry of args.tool_uses) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { recipient_name?: unknown; parameters?: unknown };
    const toolName = normalizeNestedToolName(record.recipient_name);
    const parameters =
      record.parameters && typeof record.parameters === "object"
        ? (record.parameters as Record<string, unknown>)
        : {};
    out.push({ toolName, parameters });
  }
  return out;
};

const parallelContainsShellCommand = (args: Record<string, unknown>): boolean =>
  getParallelToolEntries(args).some(
    (entry) => entry.toolName === "exec_command",
  );

const isReadOnlyShellCommand = (args: Record<string, unknown>): boolean => {
  const command =
    typeof args.cmd === "string"
      ? args.cmd
      : typeof args.command === "string"
        ? args.command
        : "";
  return command.trim().length > 0 && isKnownSafeCommand(command);
};

const parallelContainsGuardedShellCommand = (
  args: Record<string, unknown>,
): boolean =>
  getParallelToolEntries(args).some(
    (entry) =>
      entry.toolName === "exec_command" &&
      !isReadOnlyShellCommand(entry.parameters),
  );

const getParallelRunningShellSessions = (result: ToolResult): string[] => {
  const details = result.details;
  if (!details || typeof details !== "object") return [];
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const sessionIds: string[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      tool_name?: unknown;
      result?: unknown;
      details?: unknown;
    };
    if (record.tool_name !== "exec_command") continue;
    const shellState = getShellExecutionState({
      result: record.result,
      details: record.details,
    });
    if (shellState?.running && shellState.sessionId) {
      sessionIds.push(shellState.sessionId);
    }
  }
  return sessionIds;
};

export type PreparedOrchestratorRun = {
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  toolWorkspaceRoot?: string;
  agentContext: LocalAgentContext;
  resolvedLlm: ReturnType<typeof resolveRunnerLlmRoute>;
  abortController: AbortController;
  /**
   * Memory-review user-turn counter AFTER incrementing for this run.
   * Only set when the run is a real user turn (Orchestrator + uiVisibility !== "hidden").
   * Consumed by finalizeOrchestratorSuccess to decide whether to spawn the review.
   */
  userTurnsSinceMemoryReview?: number;
};

export const prepareOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  toolWorkspaceRoot?: string;
}): Promise<PreparedOrchestratorRun> => {
  const isUserTurn = args.uiVisibility !== "hidden";

  const agentContext = await args.buildAgentContext({
    conversationId: args.conversationId,
    agentType: args.agentType,
    runId: args.runId,
    ...(args.toolWorkspaceRoot ? { toolWorkspaceRoot: args.toolWorkspaceRoot } : {}),
  });
  const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
    args.context,
    args.agentType,
    agentContext.model,
  );

  args.context.state.activeOrchestratorRunId = args.runId;
  args.context.state.activeOrchestratorConversationId = args.conversationId;
  args.context.state.activeOrchestratorUiVisibility =
    args.uiVisibility ?? "visible";

  const abortController = new AbortController();
  args.context.state.activeRunAbortControllers.set(args.runId, abortController);

  // Increment the memory-review counter only on real user-driven turns
  // for agents that declare the `triggersMemoryReview` capability.
  // Synthetic task-callback turns (uiVisibility === "hidden") and
  // capability-less agents do not count — they would inflate the counter
  // without representing user input.
  let userTurnsSinceMemoryReview: number | undefined;
  if (
    isUserTurn &&
    agentHasCapability(args.agentType, "triggersMemoryReview")
  ) {
    try {
      userTurnsSinceMemoryReview =
        args.context.runtimeStore.incrementUserTurnsSinceMemoryReview(
          args.conversationId,
        );
    } catch {
      // Memory review is best-effort. Counter failure must not block the turn.
    }
  }

  return {
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
    ...(args.toolWorkspaceRoot
      ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
      : {}),
    agentContext,
    resolvedLlm,
    abortController,
    ...(userTurnsSinceMemoryReview != null
      ? { userTurnsSinceMemoryReview }
      : {}),
  };
};

export const launchPreparedOrchestratorRun = (args: {
  context: RunnerContext;
  prepared: PreparedOrchestratorRun;
  userMessageId: string;
  runtimeCallbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
}): void => {
  const { prepared, context } = args;

  // Long-lived per-conversation session for the Pi engine path. The Pi
  // path inside `runOrchestratorTurn` routes through `session.runTurn(opts)`
  // so the underlying `Agent` (and its `state.messages`) survives across
  // turns. External engines ignore the session and use their own per-turn
  // flow.
  const orchestratorSession = getOrCreateOrchestratorSession(
    context.state.orchestratorSessions,
    prepared.conversationId,
  );

  const shouldAttachSelfModLifecycle =
    agentControlsSelfModHmr(prepared.agentType) &&
    Boolean(context.selfModLifecycle);
  let selfModLifecycleClosed = !shouldAttachSelfModLifecycle;
  const guardedShellSessionLeases = new Map<string, Set<string>>();
  const guardedShellLeaseSessions = new Map<string, string>();

  const endShellMutationGuard = async () => {
    const result = await context.selfModHmrController
      ?.endShellMutationGuard()
      .catch((error) => {
        console.warn(
          "[self-mod-hmr] failed to end shell mutation guard:",
          (error as Error).message,
        );
        return null;
      });
    if (result?.ok && result.changedPaths.length > 0) {
      try {
        await recordWritePaths(
          result.changedPaths.map((repoRelativePath) =>
            context.stellaRoot
              ? `${context.stellaRoot}/${repoRelativePath}`
              : repoRelativePath,
          ),
        );
      } catch (error) {
        console.warn(
          "[self-mod-hmr] failed to record suppressed shell updates:",
          (error as Error).message,
        );
      }
    }
  };

  const retainShellGuardLease = (sessionIds: string[]): boolean => {
    const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueSessionIds.length === 0) return false;
    const leaseId = crypto.randomUUID();
    const sessions = new Set(uniqueSessionIds);
    guardedShellSessionLeases.set(leaseId, sessions);
    for (const sessionId of sessions) {
      guardedShellLeaseSessions.set(sessionId, leaseId);
    }
    return true;
  };

  const releaseShellSessionGuard = async (sessionId: string) => {
    const leaseId = guardedShellLeaseSessions.get(sessionId);
    if (!leaseId) return;
    const sessions = guardedShellSessionLeases.get(leaseId);
    if (!sessions) return;
    sessions.delete(sessionId);
    guardedShellLeaseSessions.delete(sessionId);
    if (sessions.size === 0) {
      guardedShellSessionLeases.delete(leaseId);
      await endShellMutationGuard();
    }
  };

  const recordWritePaths = async (
    paths: string[],
    options?: { captureSnapshot?: boolean },
  ) => {
    if (!shouldAttachSelfModLifecycle || !context.selfModHmrController) {
      return;
    }
    if (paths.length === 0) return;
    await context.selfModHmrController.recordWrite(
      prepared.runId,
      paths,
      options,
    );
  };

  const recordToolWrites = async (event: {
    fileChanges?: FileChangeRecord[];
    producedFiles?: ProducedFileRecord[];
  }) => {
    const paths = [
      ...collectWrittenPaths(event.fileChanges),
      ...collectWrittenPaths(event.producedFiles),
    ];
    try {
      await recordWritePaths(paths);
    } catch (error) {
      console.warn(
        "[self-mod-hmr] recordWrite failed (continuing):",
        (error as Error).message,
      );
    }
  };

  const toolExecutor: Parameters<typeof runOrchestratorTurn>[0]["toolExecutor"] =
    async (toolName, toolArgs, toolContext, signal, onUpdate) => {
      const isShellCommand = toolName === "exec_command";
      const shouldGuardShellCommand =
        isShellCommand && !isReadOnlyShellCommand(toolArgs);
      const isShellPoll = toolName === "write_stdin";
      const isParallelWithShellCommands =
        toolName === "multi_tool_use_parallel" &&
        parallelContainsShellCommand(toolArgs);
      const isParallelWithGuardedShellCommands =
        toolName === "multi_tool_use_parallel" &&
        parallelContainsGuardedShellCommand(toolArgs);
      const shellSessionId =
        typeof toolArgs.session_id === "string" ? toolArgs.session_id : null;
      const isGuardedShellPoll =
        isShellPoll && shellSessionId
          ? guardedShellLeaseSessions.has(shellSessionId)
          : false;
      let shellGuardActive = false;
      if (
        (shouldGuardShellCommand || isParallelWithGuardedShellCommands) &&
        shouldAttachSelfModLifecycle
      ) {
        shellGuardActive = Boolean(
          await context.selfModHmrController
            ?.beginShellMutationGuard()
            .catch((error) => {
              console.warn(
                "[self-mod-hmr] failed to begin shell mutation guard:",
                (error as Error).message,
              );
              return false;
            }),
        );
        if (!shellGuardActive) {
          return {
            error:
              "Self-mod HMR shell guard failed before running a mutating shell command.",
          };
        }
      }

      try {
        const preWritePaths = inferPreWritePaths(
          toolName,
          toolArgs,
          toolContext,
        );
        if (preWritePaths.length > 0) {
          try {
            await recordWritePaths(preWritePaths, { captureSnapshot: false });
          } catch (error) {
            console.warn(
              "[self-mod-hmr] pre-write recordWrite failed:",
              (error as Error).message,
            );
            return {
              error: `Self-mod HMR tracking failed before write: ${(error as Error).message}`,
            };
          }
        }

        const result = await context.toolHost.executeTool(
          toolName,
          toolArgs,
          toolContext,
          signal,
          onUpdate,
        );
        if (
          isShellCommand ||
          isParallelWithShellCommands ||
          isGuardedShellPoll
        ) {
          await recordToolWrites({
            fileChanges: result.fileChanges,
            producedFiles: result.producedFiles,
          });
        }
        const shellState = getShellExecutionState(result);
        if (
          isShellCommand &&
          shellGuardActive &&
          shellState?.running &&
          shellState.sessionId
        ) {
          if (retainShellGuardLease([shellState.sessionId])) {
            shellGuardActive = false;
          }
        } else if (isParallelWithShellCommands && shellGuardActive) {
          const runningSessionIds = getParallelRunningShellSessions(result);
          if (retainShellGuardLease(runningSessionIds)) {
            shellGuardActive = false;
          }
        } else if (
          isGuardedShellPoll &&
          shellSessionId &&
          (shellState?.running === false || shellState == null)
        ) {
          await releaseShellSessionGuard(shellSessionId);
        }
        return result;
      } finally {
        if (shellGuardActive) {
          await endShellMutationGuard();
        }
      }
    };

  void (async () => {
    if (shouldAttachSelfModLifecycle) {
      await context.selfModHmrController?.beginRun(prepared.runId);
      await Promise.resolve(
        context.selfModLifecycle!.beginRun({
          runId: prepared.runId,
          taskDescription: "Install Stella update",
          taskPrompt: prepared.userPrompt,
          conversationId: prepared.conversationId,
          mode: "update",
        }),
      );
    }

    await runOrchestratorTurn({
      runId: prepared.runId,
      conversationId: prepared.conversationId,
      userMessageId: args.userMessageId,
      agentType: prepared.agentType,
      userPrompt: prepared.userPrompt,
      ...(prepared.uiVisibility ? { uiVisibility: prepared.uiVisibility } : {}),
      ...(prepared.promptMessages?.length
        ? { promptMessages: prepared.promptMessages }
        : {}),
      ...(prepared.responseTarget
        ? { responseTarget: prepared.responseTarget }
        : {}),
      attachments: prepared.attachments,
      agentContext: prepared.agentContext,
      callbacks: args.runtimeCallbacks,
      toolCatalog: context.toolHost.getToolCatalog(prepared.agentType, {
        model:
          prepared.resolvedLlm.toolPolicyModel ?? prepared.resolvedLlm.model,
        agentEngine: prepared.agentContext.agentEngine,
      }),
      toolExecutor,
      deviceId: context.deviceId,
      stellaHome: context.stellaRoot,
      resolvedLlm: prepared.resolvedLlm,
      store: context.runtimeStore,
      abortSignal: prepared.abortController.signal,
      stellaRoot: context.stellaRoot,
      ...(prepared.toolWorkspaceRoot
        ? { toolWorkspaceRoot: prepared.toolWorkspaceRoot }
        : {}),
      selfModMonitor: context.selfModMonitor,
      hookEmitter: context.hookEmitter,
      onExecutionSessionCreated: args.onExecutionSessionCreated,
      orchestratorSession,
      beforeRunEnd: async () => {
        if (!shouldAttachSelfModLifecycle || selfModLifecycleClosed) {
          return;
        }
        await Promise.resolve(
          context.selfModLifecycle!.finalizeRun({
            runId: prepared.runId,
            taskDescription: "Install Stella update",
            taskPrompt: prepared.userPrompt,
            conversationId: prepared.conversationId,
            // Orchestrator's threadKey is the conversationId itself
            // (`resolveOrchestratorThreadKey`). Recorded as the
            // `Stella-Thread` trailer so a future revert routes the
            // notice back to the orchestrator session.
            threadKey: prepared.conversationId,
            succeeded: true,
          }),
        );
        selfModLifecycleClosed = true;
      },
      compactionScheduler: context.state.compactionScheduler,
      ...(prepared.userTurnsSinceMemoryReview != null
        ? { userTurnsSinceMemoryReview: prepared.userTurnsSinceMemoryReview }
        : {}),
    });
  })()
    .catch((error) => {
      if (isReportedOrchestratorError(error)) {
        return;
      }
      args.cleanupRun(prepared.runId);
      args.onFatalError(error);
    })
    .finally(() => {
      if (!shouldAttachSelfModLifecycle || selfModLifecycleClosed) {
        return;
      }
      selfModLifecycleClosed = true;
      void Promise.resolve(
        context.selfModLifecycle?.cancelRun?.(prepared.runId),
      ).catch(() => undefined);
    });
};

export const startPreparedOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  createRuntimeCallbacks: (args: {
    runId: string;
    prepared: PreparedOrchestratorRun;
  }) => RuntimeRunCallbacks;
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  userMessageId: string;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
  onPrepared?: (prepared: PreparedOrchestratorRun) => void;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
}): Promise<{ runId: string; prepared: PreparedOrchestratorRun }> => {
  const prepared = await prepareOrchestratorRun({
    context: args.context,
    buildAgentContext: args.buildAgentContext,
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
  });

  args.onPrepared?.(prepared);

  launchPreparedOrchestratorRun({
    context: args.context,
    prepared,
    userMessageId: args.userMessageId,
    runtimeCallbacks: args.createRuntimeCallbacks({
      runId: args.runId,
      prepared,
    }),
    onExecutionSessionCreated: args.onExecutionSessionCreated,
    cleanupRun: args.cleanupRun,
    onFatalError: args.onFatalError,
  });

  return { runId: args.runId, prepared };
};
