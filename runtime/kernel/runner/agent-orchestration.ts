import crypto from "crypto";
import { resolveLlmRoute } from "../model-routing.js";
import { getMaxAgentConcurrency } from "../preferences/local-preferences.js";
import { runSubagentTask, shutdownSubagentRuntimes } from "../agent-runtime.js";
import { createAgentLifecycleResponseTarget } from "../agent-runtime/response-target.js";
import { persistThreadCustomMessage } from "../agent-runtime/thread-memory.js";
import { runExplore } from "../agent-runtime/explore.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";
import { shouldUseAutomaticSkillExplore } from "../shared/skill-catalog.js";
import { LocalAgentManager } from "../agents/local-agent-manager.js";
import { extractApplyPatchTargetPaths } from "../tools/apply-patch.js";
import { isKnownSafeCommand } from "../tools/safe-commands.js";
import {
  inferShellMentionedPaths,
  resolveToolPath,
} from "../tools/path-inference.js";
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
} from "../../../desktop/src/shared/contracts/agent-runtime.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "../../../desktop/src/shared/contracts/file-changes.js";
import type { RunnerContext } from "./types.js";
import { buildAgentEventPrompt } from "./shared.js";

const TASK_LIFECYCLE_WAKE_PROMPT =
  "<system_reminder>Continue from the latest task lifecycle update.</system_reminder>";

const COMMIT_MESSAGE_MAX_FILES_IN_PROMPT = 30;
const COMMIT_MESSAGE_DIFF_MAX_LINES = 240;
const COMMIT_MESSAGE_FALLBACK_SUBJECT_MAX_WORDS = 12;

const truncateForCommitSubject = (raw: string): string => {
  const cleaned = raw
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\r?\n.*$/s, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return cleaned;
  const words = cleaned.split(" ");
  if (words.length <= COMMIT_MESSAGE_FALLBACK_SUBJECT_MAX_WORDS) {
    return cleaned;
  }
  return `${words.slice(0, COMMIT_MESSAGE_FALLBACK_SUBJECT_MAX_WORDS).join(" ")}…`;
};

const buildCommitMessagePrompt = (input: {
  taskDescription: string;
  files: string[];
  diffPreview: string;
}): string => {
  const filesShown = input.files.slice(0, COMMIT_MESSAGE_MAX_FILES_IN_PROMPT);
  const filesOmitted = Math.max(0, input.files.length - filesShown.length);
  const filesBlock =
    filesShown.length > 0
      ? `Files changed:\n${filesShown.map((file) => `- ${file}`).join("\n")}${
          filesOmitted > 0 ? `\n(...and ${filesOmitted} more files)` : ""
        }`
      : "Files changed: (none reported)";
  const diffLines = input.diffPreview ? input.diffPreview.split("\n") : [];
  const trimmedDiff =
    diffLines.length > COMMIT_MESSAGE_DIFF_MAX_LINES
      ? `${diffLines.slice(0, COMMIT_MESSAGE_DIFF_MAX_LINES).join("\n")}\n... [diff truncated]`
      : input.diffPreview;
  const diffBlock = trimmedDiff
    ? `Diff (truncated):\n\`\`\`diff\n${trimmedDiff}\n\`\`\``
    : "Diff: (not available)";

  return [
    "Write the commit subject for the Stella changes you just made.",
    "",
    "Output a single short imperative sentence describing what changed and why.",
    "Constraints:",
    "- Plain English, friendly to a non-developer reader.",
    "- No leading prefix like 'feat:' or 'fix:'.",
    "- No trailing period.",
    "- 12 words or fewer.",
    "- One line only.",
    "- Refer to user-visible behavior when possible.",
    "- Respond with the subject only: no quotes, no explanation, no markdown.",
    "",
    `Original task: ${input.taskDescription.trim() || "(no task description)"}`,
    "",
    filesBlock,
    "",
    diffBlock,
  ].join("\n");
};

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

  if (toolName === "exec_command") {
    if (isReadOnlyShellCommand(args)) return [];
    return inferShellMentionedPaths(args, context);
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
      };
    case "agent-completed":
      return {
        agentId: event.agentId,
        ...(event.result ? { result: event.result } : {}),
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
      agentContext,
      taskDescription,
      taskPrompt,
      abortSignal,
      selfModMetadata,
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

      const resolvedLlm = resolveLlmRoute({
        stellaRoot: context.stellaRoot,
        modelName: agentContext.model,
        agentType,
        site: {
          baseUrl: context.state.convexSiteUrl,
          getAuthToken: () => context.state.authToken?.trim(),
        },
      });
      const runnerCallbacks =
        (rootRunId ? context.state.runCallbacksByRunId.get(rootRunId) : null) ??
        context.state.conversationCallbacks.get(conversationId) ??
        null;

      if (shouldAttachSelfModLifecycle) {
        // Register the run with the contention tracker before any writes can
        // arrive. recordWrite is a no-op on unknown runs to avoid resurrecting
        // already-finalized runs, so beginRun must precede writes.
        context.selfModHmrController?.beginRun(runId);
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
        await context.selfModHmrController
          ?.endShellMutationGuard()
          .catch((error) => {
            console.warn(
              "[self-mod-hmr] failed to end shell mutation guard:",
              (error as Error).message,
            );
          });
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
          toolCatalog: context.toolHost.getToolCatalog(agentType),
          toolExecutor: hmrAwareToolExecutor,
          deviceId: context.deviceId,
          stellaHome: context.stellaRoot,
          resolvedLlm,
          store: context.runtimeStore,
          abortSignal,
          stellaRoot: context.stellaRoot,
          selfModMonitor: context.selfModMonitor,
          onProgress,
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
              pendingToolWriteRecords.push(
                recordToolWrites({
                  fileChanges: event.fileChanges,
                  producedFiles: event.producedFiles,
                }),
              );
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
            const commitMessageProvider = async (input: {
              taskDescription: string;
              files: string[];
              diffPreview: string;
            }) => {
              if (!agentId) {
                return null;
              }
              const commitMessageRunId = `local:sub:${crypto.randomUUID()}`;
              const commitMessageContext = await deps.buildAgentContext({
                conversationId,
                agentType,
                runId: commitMessageRunId,
                threadId: agentId,
              });
              commitMessageContext.maxAgentDepth = agentContext.maxAgentDepth;
              commitMessageContext.agentDepth = agentContext.agentDepth;
              const result = await runSubagentTask({
                conversationId,
                userMessageId: commitMessageRunId,
                runId: commitMessageRunId,
                agentId,
                ...(rootRunId ? { rootRunId } : {}),
                agentType,
                userPrompt: buildCommitMessagePrompt(input),
                uiVisibility: "hidden",
                agentContext: commitMessageContext,
                toolCatalog: [],
                toolExecutor: async () => ({
                  error:
                    "Tools are not available while writing a commit subject.",
                }),
                deviceId: context.deviceId,
                stellaHome: context.stellaRoot,
                resolvedLlm,
                store: context.runtimeStore,
                suppressCompletionSideEffects: true,
                ...(abortSignal ? { abortSignal } : {}),
                stellaRoot: context.stellaRoot,
              });
              if (result.error) {
                return null;
              }
              return truncateForCommitSubject(result.result) || null;
            };
            await Promise.resolve(
              context.selfModLifecycle!.finalizeRun({
                runId,
                ...(rootRunId ? { rootRunId } : {}),
                taskDescription,
                taskPrompt,
                conversationId,
                succeeded: true,
                commitMessageProvider,
                ...(effectiveSelfModMetadata ?? {}),
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

  const shutdown = () => {
    context.state.localAgentManager?.shutdown();
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalAgent,
    createBackgroundAgent,
    shutdown,
  };
};
