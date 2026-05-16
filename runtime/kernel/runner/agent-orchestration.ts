import crypto from "crypto";
import { resolveLlmRoute } from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import {
  getDefaultModel,
  getMaxAgentConcurrency,
  getModelOverride,
} from "../preferences/local-preferences.js";
import { runSubagentTask, shutdownSubagentRuntimes } from "../agent-runtime.js";
import { createAgentLifecycleResponseTarget } from "../agent-runtime/response-target.js";
import { persistThreadCustomMessage } from "../agent-runtime/thread-memory.js";
import { runExplore } from "../agent-runtime/explore.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";
import { shouldUseAutomaticSkillExplore } from "../shared/skill-catalog.js";
import { LocalAgentManager } from "../agents/local-agent-manager.js";
import { extractApplyPatchTargetPaths } from "../tools/apply-patch.js";
import { isKnownSafeCommand } from "../tools/safe-commands.js";
import { resolveToolPath } from "../tools/path-inference.js";
import type {
  AgentToolRequest,
  ToolContext,
  ToolResult,
} from "../tools/types.js";
import type {
  LocalAgentContext,
  AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import {
  AGENT_IDS,
  isLocalCliAgentId,
} from "../../contracts/agent-runtime.js";
import { TASK_LIFECYCLE_WAKE_PROMPT } from "../../contracts/system-reminders.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "../../contracts/file-changes.js";
import type { RunnerContext } from "./types.js";
import { buildAgentEventPrompt } from "./shared.js";
import {
  buildCommitSubjectPrompt,
  buildFeatureSnapshotPrompt,
  parseFeatureSnapshotItems,
  sanitizeAuthoredCommitSubject,
} from "../self-mod/feature-namer.js";

const collectFileChanges = (
  target: FileChangeRecord[],
  seen: Set<string>,
  source: unknown,
): void => {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  const candidate = (source as { fileChanges?: unknown }).fileChanges;
  if (!isFileChangeRecordArray(candidate)) {
    return;
  }
  for (const change of candidate) {
    const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? (change.kind.move_path ?? "") : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(change);
  }
};

const collectProducedFiles = (
  target: ProducedFileRecord[],
  seen: Set<string>,
  source: unknown,
): void => {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  const candidate = (source as { producedFiles?: unknown }).producedFiles;
  if (!isProducedFileRecordArray(candidate)) {
    return;
  }
  for (const file of candidate) {
    const key = `${file.kind.type}:${file.path}:${file.kind.type === "update" ? (file.kind.move_path ?? "") : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(file);
  }
};

/**
 * Pulls the absolute paths a tool actually wrote to from its `fileChanges` /
 * `producedFiles` records (commit 95f74a28). The contention tracker needs
 * destination paths, so for `update` records with a `move_path` we surface
 * both the source and destination — both might be relevant if the move
 * crosses a tracked source root.
 */
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

  // exec_command intentionally has no pre-write path inference. Shell-mentioned
  // tokens are speculative — they tell us what the command might touch, not
  // what it actually wrote — and seeding them as writes makes finalize build
  // an apply batch (and morph) for read-only or exploration commands. The
  // shell mutation guard (beginShellMutationGuard) already snapshots all of
  // desktop/src globally for the duration of a non-safe shell command, and
  // post-tool recordToolWrites uses the tool's fileChanges/producedFiles to
  // record only paths that were actually modified.

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

const parallelToolResultContainsShellCommand = (details: unknown): boolean => {
  if (!details || typeof details !== "object") return false;
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return false;
  return results.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { tool_name?: unknown }).tool_name === "exec_command";
  });
};

const resolveSelfModMetadata = (args: {
  agentType: string;
  selfModMetadata?: AgentToolRequest["selfModMetadata"];
}): AgentToolRequest["selfModMetadata"] | undefined => {
  if (args.selfModMetadata) {
    return {
      ...args.selfModMetadata,
      mode: args.selfModMetadata.mode ?? "author",
    };
  }
  if (args.agentType !== AGENT_IDS.GENERAL) {
    return undefined;
  }
  return { mode: "author" };
};

const buildLifecycleEventPayload = (
  event: AgentLifecycleEvent,
): Record<string, unknown> => {
  switch (event.type) {
    case "agent-started":
      return {
        agentId: event.agentId,
        description: event.description,
        agentType: event.agentType,
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
        ...(event.statusText ? { statusText: event.statusText } : {}),
      };
    case "agent-completed":
      // `result` is always persisted (even if empty) so the
      // orchestrator's hidden `[Agent completed]` reminder always
      // carries a `result:` line. `finalizeSubagentSuccess`
      // substitutes a sentinel for empty/whitespace outputs upstream;
      // this guard catches any other emitter that forgets.
      return {
        agentId: event.agentId,
        result: event.result ?? "",
        ...(event.fileChanges?.length
          ? { fileChanges: event.fileChanges }
          : {}),
        ...(event.producedFiles?.length
          ? { producedFiles: event.producedFiles }
          : {}),
      };
    case "agent-failed":
    case "agent-canceled":
      return {
        agentId: event.agentId,
        ...(event.error ? { error: event.error } : {}),
      };
    case "agent-progress":
      return {
        agentId: event.agentId,
        statusText: event.statusText,
        ...(event.description ? { description: event.description } : {}),
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
      };
  }
};

const appendAgentLifecycleChatEvent = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
) => {
  if (!context.appendLocalChatEvent) {
    return;
  }
  context.appendLocalChatEvent({
    conversationId: event.conversationId,
    type: event.type,
    payload: buildLifecycleEventPayload(event),
  });
};

export const createAgentOrchestration = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;
      selfModMetadata?: AgentToolRequest["selfModMetadata"];
    }) => Promise<LocalAgentContext>;
    sendMessage: (input: {
      conversationId: string;
      text: string;
      uiVisibility?: "visible" | "hidden";
      agentType?: string;
      deliverAs?: "steer" | "followUp";
      callbackRunId?: string;
      responseTarget?: import("../../protocol/index.js").RuntimeAgentEventPayload["responseTarget"];
      customType?: string;
      display?: boolean;
      wakePrompt?: string;
    }) => Promise<void>;
  },
) => {
  context.state.localAgentManager = new LocalAgentManager({
    maxConcurrent: 24,
    getMaxConcurrent: () => getMaxAgentConcurrency(context.stellaRoot),
    resolveTaskThread: ({ conversationId, agentType, threadId }) => {
      if (!isLocalCliAgentId(agentType)) {
        return null;
      }
      return context.runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType,
        threadId,
      });
    },
    listActiveThreads: (conversationId) =>
      context.runtimeStore.listActiveThreads(conversationId),
    onAgentEvent: (event) => {
      appendAgentLifecycleChatEvent(context, event);
      if (event.rootRunId) {
        context.state.runCallbacksByRunId
          .get(event.rootRunId)
          ?.onAgentEvent?.(event);
      }
      const userPrompt = buildAgentEventPrompt(event);
      if (!userPrompt) {
        return;
      }
      // The follow-up below is in-memory delivery for the active orchestrator
      // session; this row is the durable record read by the next history rebuild.
      persistThreadCustomMessage(context.runtimeStore, {
        threadKey: resolveOrchestratorThreadKey(event.conversationId),
        customType: "runtime.task_lifecycle",
        content: [{ type: "text", text: userPrompt }],
        display: false,
        timestamp: Date.now(),
      });
      void deps.sendMessage({
        conversationId: event.conversationId,
        text: userPrompt,
        uiVisibility: "hidden",
        agentType: AGENT_IDS.ORCHESTRATOR,
        deliverAs: "followUp",
        callbackRunId: event.rootRunId,
        customType: "runtime.task_lifecycle",
        display: false,
        wakePrompt: TASK_LIFECYCLE_WAKE_PROMPT,
        responseTarget: createAgentLifecycleResponseTarget({
          agentId: event.agentId,
          eventType: event.type,
        }),
      });
    },
    fetchAgentContext: deps.buildAgentContext,
    runSubagent: async ({
      conversationId,
      userMessageId,
      agentType,
      agentId,
      rootRunId,
      toolWorkspaceRoot,
      agentContext,
      taskDescription,
      taskPrompt,
      abortSignal,
      selfModMetadata,
      subagentSession,
      onProgress,
      toolExecutor,
    }) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const effectiveSelfModMetadata = resolveSelfModMetadata({
        agentType,
        selfModMetadata,
      });
      const shouldAttachSelfModLifecycle =
        Boolean(effectiveSelfModMetadata) && Boolean(context.selfModLifecycle);

      const site = {
        baseUrl: context.state.convexSiteUrl,
        getAuthToken: () => context.state.authToken?.trim(),
        refreshAuthToken: async () => {
          const result = await context.requestRuntimeAuthRefresh?.({
            source: "stella_provider",
          });
          return result?.authenticated ? result.token : null;
        },
      };
      const resolvedLlm = await withStellaModelCatalogMetadata({
        route: resolveLlmRoute({
          stellaRoot: context.stellaRoot,
          modelName: agentContext.model,
          agentType,
          site,
        }),
        agentType,
        site,
        deviceId: context.deviceId,
        modelCatalogUpdatedAt: context.state.modelCatalogUpdatedAt,
      });
      const runnerCallbacks =
        (rootRunId ? context.state.runCallbacksByRunId.get(rootRunId) : null) ??
        context.state.conversationCallbacks.get(conversationId) ??
        null;

      if (shouldAttachSelfModLifecycle) {
        // Register the run with the contention tracker before any writes can
        // arrive. recordWrite is a no-op on unknown runs to avoid resurrecting
        // already-finalized runs, so beginRun must precede writes.
        await context.selfModHmrController?.beginRun(runId);
        await Promise.resolve(
          context.selfModLifecycle!.beginRun({
            runId,
            ...(rootRunId ? { rootRunId } : {}),
            taskDescription,
            taskPrompt,
            conversationId,
            ...(effectiveSelfModMetadata ?? {}),
          }),
        );
      }
      let exploreFindingsBlock = "";
      if (
        agentType === AGENT_IDS.GENERAL &&
        (await shouldUseAutomaticSkillExplore(context.stellaRoot))
      ) {
        exploreFindingsBlock = await runExplore({
          context,
          conversationId,
          taskDescription,
          taskPrompt,
          signal: abortSignal,
        });
      }

      const composedUserPrompt = exploreFindingsBlock
        ? `${exploreFindingsBlock}\n\n${taskDescription}\n\n${taskPrompt}`
        : `${taskDescription}\n\n${taskPrompt}`;

      let subagentSucceeded = false;
      const subagentFileChanges: FileChangeRecord[] = [];
      const subagentFileChangeKeys = new Set<string>();
      const subagentProducedFiles: ProducedFileRecord[] = [];
      const subagentProducedFileKeys = new Set<string>();
      const pendingToolWriteRecords: Promise<void>[] = [];
      const guardedShellSessionLeases = new Map<string, string>();
      const guardedShellLeaseSessions = new Map<string, Set<string>>();

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

      const releaseGuardedShellSessions = async () => {
        const leaseCount = guardedShellLeaseSessions.size;
        guardedShellSessionLeases.clear();
        guardedShellLeaseSessions.clear();
        for (let i = 0; i < leaseCount; i += 1) {
          await endShellMutationGuard();
        }
      };

      const hasGuardedShellSessions = () => guardedShellLeaseSessions.size > 0;

      const killGuardedShellSessions = async () => {
        if (!hasGuardedShellSessions()) return;
        const sessionIds = [...guardedShellSessionLeases.keys()];
        console.warn(
          "[self-mod-hmr] mutating shell session still running at finalize; killing guarded shell sessions and cancelling self-mod apply.",
        );
        await Promise.allSettled(
          sessionIds.map((sessionId) => context.toolHost.killShell(sessionId)),
        );
      };

      const retainShellGuardLease = (sessionIds: string[]) => {
        const uniqueSessionIds = [...new Set(sessionIds)].filter(Boolean);
        if (uniqueSessionIds.length === 0) return false;
        const leaseId = crypto.randomUUID();
        guardedShellLeaseSessions.set(leaseId, new Set(uniqueSessionIds));
        for (const sessionId of uniqueSessionIds) {
          guardedShellSessionLeases.set(sessionId, leaseId);
        }
        return true;
      };

      const releaseShellSessionGuard = async (sessionId: string) => {
        const leaseId = guardedShellSessionLeases.get(sessionId);
        if (!leaseId) return;
        guardedShellSessionLeases.delete(sessionId);
        const sessions = guardedShellLeaseSessions.get(leaseId);
        if (!sessions) return;
        sessions.delete(sessionId);
        if (sessions.size > 0) return;
        guardedShellLeaseSessions.delete(leaseId);
        await endShellMutationGuard();
      };

      const recordWritePaths = async (
        paths: string[],
        options?: { captureSnapshot?: boolean },
      ) => {
        if (!shouldAttachSelfModLifecycle || !context.selfModHmrController) {
          return;
        }
        if (paths.length === 0) return;
        await context.selfModHmrController.recordWrite(runId, paths, options);
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

      const hmrAwareToolExecutor = async (
        toolName: string,
        args: Record<string, unknown>,
        ctx: ToolContext,
        signal?: AbortSignal,
        onUpdate?: (update: ToolResult) => void,
      ): Promise<ToolResult> => {
        const isShellCommand = toolName === "exec_command";
        const shouldGuardShellCommand =
          isShellCommand && !isReadOnlyShellCommand(args);
        const isShellPoll = toolName === "write_stdin";
        const isParallelWithShellCommands =
          toolName === "multi_tool_use_parallel" &&
          parallelContainsShellCommand(args);
        const isParallelWithGuardedShellCommands =
          toolName === "multi_tool_use_parallel" &&
          parallelContainsGuardedShellCommand(args);
        const shellSessionId =
          typeof args.session_id === "string" ? args.session_id : null;
        const isGuardedShellPoll =
          isShellPoll && shellSessionId
            ? guardedShellSessionLeases.has(shellSessionId)
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
          const preWritePaths = inferPreWritePaths(toolName, args, ctx);
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
          const result = await toolExecutor(
            toolName,
            args,
            ctx,
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
      try {
        const result = await runSubagentTask({
          conversationId,
          userMessageId,
          runId,
          agentId,
          rootRunId,
          agentType,
          userPrompt: composedUserPrompt,
          selfModMetadata: effectiveSelfModMetadata,
          agentContext,
          toolCatalog: context.toolHost.getToolCatalog(agentType, {
            model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
            agentEngine: agentContext.agentEngine,
          }),
          toolExecutor: hmrAwareToolExecutor,
          deviceId: context.deviceId,
          stellaHome: context.stellaRoot,
          resolvedLlm,
          store: context.runtimeStore,
          abortSignal,
          stellaRoot: context.stellaRoot,
          ...(toolWorkspaceRoot ? { toolWorkspaceRoot } : {}),
          ...(subagentSession ? { subagentSession } : {}),
          compactionScheduler: context.state.compactionScheduler,
          selfModMonitor: context.selfModMonitor,
          onProgress,
          ...(context.appendLocalChatEvent
            ? { appendLocalChatEvent: context.appendLocalChatEvent }
            : {}),
          ...(context.listLocalChatEvents
            ? { listLocalChatEvents: context.listLocalChatEvents }
            : {}),
          resolveSubsidiaryLlmRoute: (subsidiaryAgentType: string) =>
            resolveLlmRoute({
              stellaRoot: context.stellaRoot,
              // Honor any per-agent override the user set for this
              // subsidiary agent (or our Assistant-tab propagation —
              // home_suggestions etc. otherwise silently hit Stella even
              // when the user moved Assistant onto BYOK).
              modelName:
                getModelOverride(context.stellaRoot, subsidiaryAgentType) ??
                getDefaultModel(context.stellaRoot, subsidiaryAgentType),
              agentType: subsidiaryAgentType,
              site: {
                baseUrl: context.state.convexSiteUrl,
                getAuthToken: () => context.state.authToken?.trim(),
                refreshAuthToken: async () => {
                  const result = await context.requestRuntimeAuthRefresh?.({
                    source: "stella_provider",
                  });
                  return result?.authenticated ? result.token : null;
                },
              },
            }),
          callbacks: {
            ...(runnerCallbacks
              ? {
                  onStream: (event) => runnerCallbacks.onStream(event),
                  onReasoning: (event) => {
                    if (!agentId) {
                      return;
                    }
                    runnerCallbacks.onAgentReasoning?.({
                      ...event,
                      agentId,
                      ...(rootRunId ? { rootRunId } : {}),
                    });
                  },
                  onToolStart: (event) => runnerCallbacks.onToolStart(event),
                  onError: (event) => runnerCallbacks.onError(event),
                  onInterrupted: (event) =>
                    runnerCallbacks.onInterrupted?.(event),
                  onEnd: (event) => runnerCallbacks.onEnd(event),
                }
              : {}),
            onToolEnd: (event) => {
              collectFileChanges(
                subagentFileChanges,
                subagentFileChangeKeys,
                event.fileChanges?.length ? event : event.details,
              );
              collectProducedFiles(
                subagentProducedFiles,
                subagentProducedFileKeys,
                event.producedFiles?.length ? event : event.details,
              );
              const shellWritesAlreadyRecorded =
                event.toolName === "exec_command" ||
                event.toolName === "write_stdin" ||
                (event.toolName === "multi_tool_use_parallel" &&
                  parallelToolResultContainsShellCommand(event.details));
              if (!shellWritesAlreadyRecorded) {
                pendingToolWriteRecords.push(
                  recordToolWrites({
                    fileChanges: event.fileChanges,
                    producedFiles: event.producedFiles,
                  }),
                );
              }
              runnerCallbacks?.onToolEnd(event);
            },
          },
          hookEmitter: context.hookEmitter,
        });
        subagentSucceeded = !result.error;
        if (subagentFileChanges.length > 0) {
          result.fileChanges = subagentFileChanges;
        }
        if (subagentProducedFiles.length > 0) {
          result.producedFiles = subagentProducedFiles;
        }
        return result;
      } finally {
        if (pendingToolWriteRecords.length > 0) {
          await Promise.allSettled(pendingToolWriteRecords);
        }
        if (hasGuardedShellSessions()) {
          await killGuardedShellSessions();
          subagentSucceeded = false;
        }
        await releaseGuardedShellSessions();
        if (shouldAttachSelfModLifecycle) {
          // The finalize/cancel hooks below own the entire apply pipeline
          // (contention tracker drain, Vite overlay swap, runtime restart,
          // morph cover). The renderer no longer participates in the
          // resume-flush dance — it just observes self-mod-hmr state events
          // emitted by the worker server.
          if (subagentSucceeded) {
            // Helper: spin up a one-shot LLM call with no tools and a
            // freshly-built agent context. Used for the commit-subject
            // namer and the rolling-window feature snapshot namer.
            const runOneShotPrompt = async (
              prompt: string,
            ): Promise<string | null> => {
              if (!agentId) return null;
              const oneShotRunId = `local:sub:${crypto.randomUUID()}`;
              const oneShotContext = await deps.buildAgentContext({
                conversationId,
                agentType,
                runId: oneShotRunId,
                threadId: agentId,
              });
              oneShotContext.maxAgentDepth = agentContext.maxAgentDepth;
              oneShotContext.agentDepth = agentContext.agentDepth;
              const result = await runSubagentTask({
                conversationId,
                userMessageId: oneShotRunId,
                runId: oneShotRunId,
                agentId,
                ...(rootRunId ? { rootRunId } : {}),
                agentType,
                userPrompt: prompt,
                uiVisibility: "hidden",
                agentContext: oneShotContext,
                toolCatalog: [],
                toolExecutor: async () => ({
                  error: "Tools are not available for this one-shot prompt.",
                }),
                deviceId: context.deviceId,
                stellaHome: context.stellaRoot,
                resolvedLlm,
                store: context.runtimeStore,
                suppressCompletionSideEffects: true,
                compactionScheduler: context.state.compactionScheduler,
                ...(abortSignal ? { abortSignal } : {}),
                stellaRoot: context.stellaRoot,
              });
              if (result.error) return null;
              return result.result ?? null;
            };

            const commitMessageProvider = async (input: {
              taskDescription: string;
              files: string[];
              diffPreview: string;
              conversationId?: string;
            }): Promise<string | null> => {
              const reply = await runOneShotPrompt(
                buildCommitSubjectPrompt(input),
              );
              if (!reply) return null;
              const subject = sanitizeAuthoredCommitSubject(reply);
              return subject || null;
            };

            const featureNamerProvider = async (input: {
              commits: Array<{
                commitHash: string;
                shortHash: string;
                subject: string;
                body: string;
                timestampMs: number;
                files: string[];
              }>;
            }): Promise<Array<{
              name: string;
              commitHashes: string[];
            }> | null> => {
              const reply = await runOneShotPrompt(
                buildFeatureSnapshotPrompt(input),
              );
              if (!reply) return null;
              return parseFeatureSnapshotItems(
                reply,
                input.commits.map((commit) => commit.commitHash),
              );
            };

            await Promise.resolve(
              context.selfModLifecycle!.finalizeRun({
                runId,
                ...(rootRunId ? { rootRunId } : {}),
                taskDescription,
                taskPrompt,
                conversationId,
                ...(agentId ? { threadKey: agentId } : {}),
                succeeded: true,
                commitMessageProvider,
                featureNamerProvider,
              }),
            );
          } else if (
            typeof context.selfModLifecycle!.cancelRun === "function"
          ) {
            await Promise.resolve(context.selfModLifecycle!.cancelRun(runId));
          }
        }
      }
    },
    toolExecutor: (toolName, args, toolContext, signal, onUpdate) =>
      context.toolHost.executeTool(
        toolName,
        args,
        toolContext,
        signal,
        onUpdate,
      ),
    createCloudAgentRecord: async () => ({
      agentId: `cloud-stub-${crypto.randomUUID().slice(0, 8)}`,
    }),
    completeCloudAgentRecord: async () => {},
    getCloudAgentRecord: async () => null,
    cancelCloudAgentRecord: async () => ({ canceled: false }),
    saveAgentRecord: (record) => context.runtimeStore.saveAgentRecord?.(record),
    getAgentRecord: (threadId) =>
      context.runtimeStore.getAgentRecord?.(threadId) ?? null,
  });

  const runBlockingLocalAgent = async (
    request: Omit<AgentToolRequest, "storageMode">,
  ): Promise<
    | { status: "ok"; finalText: string; threadId: string }
    | { status: "error"; finalText: ""; error: string; threadId?: string }
  > => {
    if (!context.state.localAgentManager) {
      return {
        status: "error",
        finalText: "",
        error: "Local agent manager is unavailable.",
      };
    }
    const { threadId } = await context.state.localAgentManager.createAgent({
      ...request,
      storageMode: "local",
    });
    while (true) {
      const snapshot = await context.state.localAgentManager.getAgent(threadId);
      if (!snapshot) {
        return {
          status: "error",
          finalText: "",
          error: "Agent record disappeared before completion.",
          threadId,
        };
      }
      if (snapshot.status === "completed") {
        return {
          status: "ok",
          finalText: snapshot.result ?? "",
          threadId,
        };
      }
      if (snapshot.status === "error" || snapshot.status === "canceled") {
        return {
          status: "error",
          finalText: "",
          error: snapshot.error ?? "Agent run failed",
          threadId,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  };

  const createBackgroundAgent = async (
    request: Omit<AgentToolRequest, "storageMode">,
  ): Promise<{ threadId: string }> => {
    if (!context.state.localAgentManager) {
      throw new Error("Local agent manager is unavailable.");
    }
    const { threadId } = await context.state.localAgentManager.createAgent({
      ...request,
      storageMode: "local",
    });
    return { threadId };
  };

  const cancelLocalAgent = async (
    agentId: string,
    reason?: string,
  ): Promise<{ canceled: boolean }> => {
    if (!context.state.localAgentManager) {
      return { canceled: false };
    }
    return await context.state.localAgentManager.cancelAgent(agentId, reason);
  };

  const shutdown = () => {
    context.state.localAgentManager?.shutdown();
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalAgent,
    createBackgroundAgent,
    cancelLocalAgent,
    shutdown,
  };
};
