import crypto from "crypto";
import path from "node:path";
import {
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import {
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
import { writeRestartInterruptedSnapshot } from "../restart-continuation.js";
import { extractApplyPatchTargetPaths } from "../tools/apply-patch.js";
import { isKnownSafeCommand } from "../tools/safe-commands.js";
import { resolveToolPath } from "../tools/path-inference.js";
import type {
  AgentToolRequest,
  ToolContext,
  ToolResult,
} from "../tools/types.js";
import type { LocalChatEventRecord } from "../storage/shared.js";
import type {
  LocalAgentContext,
  AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import { AGENT_IDS, isLocalCliAgentId } from "../../contracts/agent-runtime.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "../../contracts/file-changes.js";
import type { RunnerContext } from "./types.js";
import { buildAgentEventPrompt } from "./shared.js";
import {
  COMMIT_SUBJECT_MAX_OUTPUT_TOKENS,
  createCommitSubjectProvider,
} from "../self-mod/feature-namer.js";
import { runLightTextCompletion } from "../agent-runtime/light-completion.js";
import {
  createRunnerImageDescriptionService,
  resolveRunnerRecallLlmRoute,
} from "./model-selection.js";
import type { BackgroundExitWake } from "./background-exit-wake.js";
import { acquireRepoMutationEpoch } from "../self-mod/mutation-epoch.js";

/**
 * Hand a finished run's still-running `exec_command` sessions to the
 * background-exit wake, so whatever the agent left running reports back to
 * it when it finishes.
 *
 * Shells outlive the run that started them on purpose. Before this, that
 * meant a build or benchmark left running past the end of a turn finished
 * into a void: nothing it printed could start a new turn, and the thread
 * just stopped. Arming here is what makes "I'll check on it when it's
 * done" something the runtime can actually deliver.
 *
 * A run with no durable thread id has nothing to resume, so it only gets
 * the warning.
 */
const armBackgroundExitWake = (args: {
  agentType: string;
  agentId?: string;
  conversationId: string;
  touchedSessionIds: string[];
  interrupted: boolean;
  listRunningShellSessionIds: (sessionIds?: string[]) => string[];
  listRunningShellSessionsOwnedBy: (agentId: string) => string[];
  backgroundExitWake?: BackgroundExitWake;
}): void => {
  try {
    // Scope by owner, not by what this run happened to touch: a benchmark
    // started two turns ago and never polled since is exactly the session
    // whose exit the thread is waiting on.
    const running = args.agentId
      ? args.listRunningShellSessionsOwnedBy(args.agentId)
      : args.listRunningShellSessionIds(args.touchedSessionIds);
    if (running.length === 0) return;
    const armedIds = args.backgroundExitWake?.arm({
      conversationId: args.conversationId,
      ...(args.agentId ? { agentId: args.agentId } : {}),
      runningSessionIds: running,
      interrupted: args.interrupted,
    });
    if (armedIds?.length) return;
    console.warn(
      `[background-wait] ${args.agentType} run ended with ${running.length} shell session(s) still running ` +
        `(conversation ${args.conversationId}${args.agentId ? `, thread ${args.agentId}` : ""}): ${running.join(", ")}. ` +
        "No exit wake was armed, so nothing they print will resume this thread.",
    );
  } catch {
    // Diagnostics and best-effort arming must never break run teardown.
  }
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

const hasPersistedThreadCustomEvent = (
  context: RunnerContext,
  threadKey: string,
  eventId: string | undefined,
): boolean => {
  if (!eventId) return false;
  const loadThreadMessages = context.runtimeStore.loadThreadMessages;
  if (typeof loadThreadMessages !== "function") return false;
  return loadThreadMessages
    .call(context.runtimeStore, threadKey)
    .some((message) => {
      if (message.customMessage?.customType !== "runtime.task_lifecycle") {
        return false;
      }
      return message.customMessage.eventId === eventId;
    });
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

const resolveExpectedSelfModWritePaths = (
  metadata: AgentToolRequest["selfModMetadata"] | undefined,
  stellaAppDir: string | undefined,
): string[] => {
  const root = stellaAppDir?.trim();
  const expected = metadata?.expectedChangedFiles;
  if (!root || !Array.isArray(expected) || expected.length === 0) return [];
  const out = new Set<string>();
  for (const filePath of expected) {
    const trimmed = filePath.trim();
    if (!trimmed) continue;
    out.add(path.isAbsolute(trimmed) ? trimmed : path.join(root, trimmed));
  }
  return [...out];
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
  if (args.agentType === AGENT_IDS.INSTALL_UPDATE) {
    return { mode: "desktop-update" };
  }
  if (args.agentType !== AGENT_IDS.GENERAL) {
    return undefined;
  }
  return { mode: "author" };
};

const buildLifecycleEventPayload = (
  event: AgentLifecycleEvent,
): Record<string, unknown> => {
  const runFields = event.rootRunId ? { rootRunId: event.rootRunId } : {};
  switch (event.type) {
    case "agent-started":
      return {
        agentId: event.agentId,
        ...runFields,
        description: event.description,
        agentType: event.agentType,
        ...(typeof event.attemptGeneration === "number"
          ? { attemptGeneration: event.attemptGeneration }
          : {}),
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
        ...(event.statusText ? { statusText: event.statusText } : {}),
        // Persist the spawn-vs-follow-up discriminator so the inline
        // background-work card can pick its follow-up variant on reload.
        ...(event.isFollowUp ? { isFollowUp: true } : {}),
      };
    case "agent-completed":
      // `result` is always persisted (even if empty) so the
      // orchestrator's hidden `[Agent completed]` reminder always
      // carries a `result:` line. `finalizeSubagentSuccess`
      // substitutes a sentinel for empty/whitespace outputs upstream;
      // this guard catches any other emitter that forgets.
      return {
        agentId: event.agentId,
        ...runFields,
        ...(typeof event.attemptGeneration === "number"
          ? { attemptGeneration: event.attemptGeneration }
          : {}),
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
        ...runFields,
        ...(typeof event.attemptGeneration === "number"
          ? { attemptGeneration: event.attemptGeneration }
          : {}),
        ...(event.error ? { error: event.error } : {}),
      };
    case "agent-progress":
      return {
        agentId: event.agentId,
        ...runFields,
        ...(typeof event.attemptGeneration === "number"
          ? { attemptGeneration: event.attemptGeneration }
          : {}),
        statusText: event.statusText,
        ...(event.toolActivity ? { toolActivity: event.toolActivity } : {}),
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
    ...(event.eventId ? { eventId: event.eventId } : {}),
    type: event.type,
    payload: buildLifecycleEventPayload(event),
  });
};

const buildThreadLifecycleEvent = (
  event: AgentLifecycleEvent,
  timestamp: number,
): LocalChatEventRecord => {
  const derivedId = `${event.agentId}:${
    event.attemptGeneration ?? timestamp
  }:${event.type}`;
  return {
    _id:
      event.eventId?.trim() ||
      (event.type === "agent-progress"
        ? `${derivedId}:${timestamp}`
        : derivedId),
    timestamp,
    type: event.type,
    payload: buildLifecycleEventPayload(event),
  };
};

export const createAgentOrchestration = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;
      /** Per-spawn model override from spawn_agent's `model` parameter. */
      model?: string;
      /** Per-spawn engine selection from spawn_agent's `model` parameter. */
      spawnEngine?: AgentToolRequest["spawnEngine"];
      /** Per-spawn reasoning override from spawn_agent's model suffix. */
      spawnReasoningEffort?: AgentToolRequest["spawnReasoningEffort"];
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
    }) => Promise<void>;
    /** Test/embedding override; production uses the manager's bounded default. */
    attemptTeardownTimeoutMs?: number;
  },
) => {
  // A send_input continuation is a new engine attempt but the same logical
  // self-mod run. Keep its checkout lease in this map until that logical run
  // is finalized/canceled so no other author can write into the gap.
  const mutationEpochReleases = new Map<string, () => Promise<void>>();

  const handleAgentLifecycleEvent = (event: AgentLifecycleEvent) => {
    const installedManager = context.state.localAgentManager;
    const parentOwner = installedManager
      ? installedManager.resolveOwningParentThread(
          event.agentId,
          event.parentAgentId,
        )
      : event.parentAgentId;
    const parentThreadId =
      typeof parentOwner === "string" ? parentOwner : undefined;
    const isParentOwned = parentThreadId !== undefined;
    const hasUnresolvedParentAncestry = parentOwner === null;
    // Interjection-turn completions arrive twice (see
    // `AgentLifecycleEvent.audience`): `orchestrator-only` skips every
    // display surface (persisted activity row, renderer/run callbacks,
    // OS notification) so the task UI keeps reading "in progress",
    // while the deferred `display-only` replay skips the hidden
    // orchestrator follow-up that already went out.
    if (
      event.audience !== "orchestrator-only" &&
      !isParentOwned &&
      !hasUnresolvedParentAncestry
    ) {
      // Progress ticks are ephemeral decoration: they stream to the renderer
      // below but are never persisted — thread state lives in
      // `runtime_agents` (see `listThreadActivity`), and persisting every
      // tick grew the message table without bound.
      if (event.type !== "agent-progress") {
        appendAgentLifecycleChatEvent(context, event);
      }
      if (event.rootRunId) {
        context.state.runCallbacksByRunId
          .get(event.rootRunId)
          ?.onAgentEvent?.(event);
      }
    }
    if (parentThreadId && event.audience !== "orchestrator-only") {
      // Subagents stay out of the root event table, but the parent's own
      // read-only thread viewer still needs the canonical lifecycle semantics
      // so spawns and completions render as cards there. Store a display-only
      // structured entry beside (not inside) the model-visible terminal
      // reminder. Starts/progress have no reminder at all, and this entry type
      // is never replayed into the parent's model context.
      const lifecycleEvent = buildThreadLifecycleEvent(event, Date.now());
      if (
        !context.runtimeStore.hasThreadLifecycleEvent(
          parentThreadId,
          lifecycleEvent._id,
        )
      ) {
        context.runtimeStore.appendThreadLifecycleEvent({
          threadKey: parentThreadId,
          event: lifecycleEvent,
        });
      }
    }
    if (event.audience === "display-only") {
      return;
    }
    // A legacy/malformed parent link or ancestry cycle cannot be attributed
    // safely. Keep the task in Activity, but never guess that it belongs in
    // root chat or let it finalize the root turn.
    if (hasUnresolvedParentAncestry) return;
    const userPrompt = buildAgentEventPrompt(event, {
      recipient: isParentOwned ? "parent_agent" : "orchestrator",
    });
    if (!userPrompt) {
      return;
    }
    if (parentThreadId) {
      // Subagent reports live in the parent agent's durable thread and wake
      // that parent directly. They never enter the top-level orchestrator's
      // history, callbacks, or hidden follow-up stream — so a nested
      // completion produces no root card and no OS notification.
      if (
        !hasPersistedThreadCustomEvent(context, parentThreadId, event.eventId)
      ) {
        persistThreadCustomMessage(context.runtimeStore, {
          threadKey: parentThreadId,
          customType: "runtime.task_lifecycle",
          content: [{ type: "text", text: userPrompt }],
          display: false,
          timestamp: Date.now(),
          ...(event.eventId ? { eventId: event.eventId } : {}),
        });
      }
      const deliveryEventId = event.eventId?.trim();
      const delivery = context.state.localAgentManager?.sendAgentMessage(
        parentThreadId,
        userPrompt,
        "orchestrator",
        {
          deliveryKind: "child-report",
          ...(deliveryEventId ? { deliveryEventId } : {}),
        },
      );
      if (deliveryEventId && delivery) {
        void delivery
          .then((result) => {
            if (result.delivered) {
              context.state.localAgentManager?.markParentWakeDelivered(
                event.agentId,
                deliveryEventId,
              );
            }
          })
          .catch(() => undefined);
      }
      return;
    }
    // The follow-up below is in-memory delivery for the active orchestrator
    // session; this row is the durable record read by the next history rebuild.
    const orchestratorThreadKey = resolveOrchestratorThreadKey(
      event.conversationId,
    );
    if (
      !hasPersistedThreadCustomEvent(
        context,
        orchestratorThreadKey,
        event.eventId,
      )
    ) {
      persistThreadCustomMessage(context.runtimeStore, {
        threadKey: orchestratorThreadKey,
        customType: "runtime.task_lifecycle",
        content: [{ type: "text", text: userPrompt }],
        display: false,
        timestamp: Date.now(),
        ...(event.eventId ? { eventId: event.eventId } : {}),
      });
    }
    // Two-phase Dream-inbox stamp, phase 2 (persist-time invariant): the
    // terminal report is now durably in this conversation's orchestrator
    // thread — the exact premise mechanical delta consumption relies on —
    // so promote the matching NULL-conversation row recorded at finalize.
    // Only THIS branch ever promotes: a superseded/adopted/crashed run
    // whose report never reached here leaves its row NULL forever (model-
    // driven path). Content-matched, so a later attempt's event can never
    // stamp an earlier attempt's unreported row. Best-effort: a missed
    // promotion (partial store, hook write racing behind) only keeps the
    // row on the model path — never enables consumption.
    if (event.type === "agent-completed" && event.result?.trim()) {
      try {
        const inbox = context.runtimeStore.dreamInboxStore;
        if (
          inbox &&
          typeof inbox.promoteThreadSummaryConversation === "function"
        ) {
          inbox.promoteThreadSummaryConversation({
            threadId: event.agentId,
            conversationId: event.conversationId,
            rolloutSummary: event.result,
          });
        }
      } catch {
        // Promotion is bookkeeping for an optimization; the row remains
        // consolidatable through the model-driven list either way.
      }
    }
    void (async () => {
      const shouldPublishSelfModCompletion =
        event.type === "agent-completed" &&
        Boolean(event.eventId) &&
        !isParentOwned &&
        event.audience !== "display-only";
      if (
        shouldPublishSelfModCompletion &&
        event.eventId &&
        context.selfModLifecycle?.publishCompletion
      ) {
        await context.selfModLifecycle
          .publishCompletion({
            conversationId: event.conversationId,
            ownerThreadId: event.agentId,
            completionEventId: event.eventId,
          })
          .catch(() => undefined);
      }
      await deps.sendMessage({
        conversationId: event.conversationId,
        text: userPrompt,
        uiVisibility: "hidden",
        agentType: AGENT_IDS.ORCHESTRATOR,
        deliverAs: "followUp",
        callbackRunId: event.rootRunId,
        customType: "runtime.task_lifecycle",
        display: false,
        responseTarget: createAgentLifecycleResponseTarget({
          agentId: event.agentId,
          eventType: event.type,
          ...(event.type === "agent-completed" && event.eventId
            ? { completionEventId: event.eventId }
            : {}),
        }),
      });
    })();
  };

  context.state.localAgentManager = new LocalAgentManager({
    maxConcurrent: 24,
    ...(deps.attemptTeardownTimeoutMs !== undefined
      ? { attemptTeardownTimeoutMs: deps.attemptTeardownTimeoutMs }
      : {}),
    getMaxConcurrent: () => getMaxAgentConcurrency(context.stellaDataDir),
    resolveTaskThread: ({ conversationId, agentType, threadId, nameHint }) => {
      if (!isLocalCliAgentId(agentType)) {
        return null;
      }
      return context.runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType,
        threadId,
        ...(nameHint ? { nameHint } : {}),
      });
    },
    listActiveThreads: (conversationId) =>
      context.runtimeStore.listActiveThreads(conversationId),
    // Restart-with-continuation: durably snapshot the still-running rows
    // BEFORE the boot sweep flips them, so a failed interruption-state
    // write can genuinely be retried on the next boot. The returned episode
    // id binds the live capture to the shutdown record present right now.
    persistBootInterruptionSnapshot: (threads) =>
      writeRestartInterruptedSnapshot(context.stellaDataDir, threads),
    onAgentEvent: handleAgentLifecycleEvent,
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
      selfModRunId,
      selfModFeature,
      onSelfModRunStarted,
      onSelfModRunClosed,
      shouldContinueSelfModLifecycleAfterInterrupt,
      subagentSession,
      onProgress,
      onStatus,
      onToolStart,
      onToolEnd,
      toolExecutor,
    }) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const lifecycleRunId = selfModRunId ?? runId;
      const isContinuingSelfModRun = Boolean(selfModRunId);
      const effectiveSelfModMetadata = resolveSelfModMetadata({
        agentType,
        selfModMetadata,
      });
      const shouldAttachSelfModLifecycle =
        Boolean(effectiveSelfModMetadata) && Boolean(context.selfModLifecycle);

      const site = {
        baseUrl: context.state.convexSiteUrl,
        getAuthToken: () => context.state.authToken?.trim(),
        hasConnectedAccount: () => context.state.hasConnectedAccount,
        refreshAuthToken: async () => {
          const result = await context.requestRuntimeAuthRefresh?.({
            source: "stella_provider",
          });
          return result?.authenticated ? result.token : null;
        },
      };
      const resolvedLlm =
        agentContext.resolvedLlm ??
        (await withStellaModelCatalogMetadata({
          route: resolveLlmRouteForCatalogEnrichment({
            // `resolveLlmRoute`'s `stellaAppDir` arg is the directory it reads
            // BYOK/local provider credentials from, which live under the data
            // dir (~/.stella), not the install/code tree. Every other runner
            // call site (model-selection.ts, resolveSubsidiaryLlmRoute below)
            // passes `stellaDataDir`; this fallback previously passed
            // `stellaAppDir`, so if a subagent ever hit this branch it would
            // look for credentials in the wrong place and diverge from the
            // orchestrator's resolution — surfacing as a spurious
            // missing-credential/provider error after a provider switch.
            stellaAppDir: context.stellaDataDir,
            modelName: agentContext.model,
            agentType,
            site,
          }),
          agentType,
          site,
          deviceId: context.deviceId,
          modelCatalogUpdatedAt: context.state.modelCatalogUpdatedAt,
          stellaDataDir: context.stellaDataDir,
          ...(context.cliBridgeSocketPath
            ? { cliBridgeSocketPath: context.cliBridgeSocketPath }
            : {}),
        }));
      const runnerCallbacks =
        (rootRunId ? context.state.runCallbacksByRunId.get(rootRunId) : null) ??
        context.state.conversationCallbacks.get(conversationId) ??
        null;

      // Every self-mod author participates in the same checkout-wide epoch.
      // Claude's vanilla Bash/MCP/Task writes cannot be fenced per tool, so a
      // narrower Claude-only lease would still let Pi/Codex writes leak into
      // Claude's final worktree snapshot and Apply commit.
      let releaseMutationEpoch = mutationEpochReleases.get(lifecycleRunId);
      if (
        !releaseMutationEpoch &&
        shouldAttachSelfModLifecycle &&
        context.stellaAppDir
      ) {
        releaseMutationEpoch = await acquireRepoMutationEpoch(
          context.stellaAppDir,
          abortSignal,
        );
        mutationEpochReleases.set(lifecycleRunId, releaseMutationEpoch);
      }
      const closeMutationEpoch = async (): Promise<void> => {
        const release = mutationEpochReleases.get(lifecycleRunId);
        if (!release) return;
        mutationEpochReleases.delete(lifecycleRunId);
        await release();
      };

      let exploreFindingsBlock = "";
      let selfModRunBegan = false;
      try {
        // This thread is awake again, so it can watch its own leftovers. Drop
        // any arm from its previous run: a background exit landing now belongs
        // to a live turn, not to a wake that would re-enter a thread already
        // running. Teardown re-arms whatever is still going.
        if (agentId) {
          context.state.backgroundExitWake?.disarm(agentId);
        }

        if (shouldAttachSelfModLifecycle) {
          // Register the run with the contention tracker before any writes can
          // arrive. recordWrite is a no-op on unknown runs to avoid resurrecting
          // already-finalized runs, so beginRun must precede writes.
          if (!isContinuingSelfModRun) {
            await context.selfModHmrController?.beginRun(lifecycleRunId);
            selfModRunBegan = true;
            const expectedWritePaths = resolveExpectedSelfModWritePaths(
              effectiveSelfModMetadata,
              context.stellaAppDir,
            );
            if (expectedWritePaths.length > 0) {
              await Promise.resolve(
                context.selfModHmrController?.recordWrite(
                  lifecycleRunId,
                  expectedWritePaths,
                  {
                    captureSnapshot: false,
                  },
                ),
              ).catch((error) => {
                console.warn(
                  "[self-mod-hmr] failed to pre-track expected self-mod update paths:",
                  (error as Error).message,
                );
              });
            }
            await Promise.resolve(
              context.selfModLifecycle!.beginRun({
                runId: lifecycleRunId,
                ...(rootRunId ? { rootRunId } : {}),
                taskDescription,
                taskPrompt,
                conversationId,
                ...(effectiveSelfModMetadata ?? {}),
              }),
            );
            onSelfModRunStarted?.(lifecycleRunId);
          }
        }
        if (
          agentType === AGENT_IDS.GENERAL &&
          (await shouldUseAutomaticSkillExplore(context.stellaDataDir))
        ) {
          exploreFindingsBlock = await runExplore({
            context,
            conversationId,
            taskDescription,
            taskPrompt,
            signal: abortSignal,
          });
        }
      } catch (error) {
        if (selfModRunBegan) {
          if (typeof context.selfModLifecycle?.cancelRun === "function") {
            await Promise.resolve(
              context.selfModLifecycle.cancelRun(lifecycleRunId),
            ).catch(() => undefined);
          } else {
            await context.selfModHmrController
              ?.cancel(lifecycleRunId)
              .catch(() => undefined);
          }
          onSelfModRunClosed?.(lifecycleRunId);
        }
        await closeMutationEpoch();
        throw error;
      }

      const composedUserPrompt = exploreFindingsBlock
        ? `${exploreFindingsBlock}\n\n${taskDescription}\n\n${taskPrompt}`
        : `${taskDescription}\n\n${taskPrompt}`;

      let subagentSucceeded = false;
      const subagentFileChanges: FileChangeRecord[] = [];
      const subagentFileChangeKeys = new Set<string>();
      const subagentProducedFiles: ProducedFileRecord[] = [];
      const subagentProducedFileKeys = new Set<string>();
      // Shell sessions this run interacted with. Background/long-running
      // commands can finish after the model's last poll, so their produced
      // files never drain inline; we sweep these sessions at finalize to pull
      // late deliverables into the completion rollup.
      const touchedShellSessions = new Set<string>();
      const pendingToolWriteRecords: Promise<void>[] = [];
      const guardedShellSessionLeases = new Map<string, string>();
      const guardedShellLeaseSessions = new Map<string, Set<string>>();
      let subagentInterrupted = false;

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
                context.stellaAppDir
                  ? `${context.stellaAppDir}/${repoRelativePath}`
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
          "[self-mod-hmr] mutating shell session still running at finalize; killing guarded shell sessions before self-mod apply.",
        );
        await Promise.allSettled(
          sessionIds.map(async (sessionId) => {
            await context.toolHost.killShell(sessionId);
          }),
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
        options?: { captureSnapshot?: boolean; createdPaths?: string[] },
      ) => {
        if (!shouldAttachSelfModLifecycle || !context.selfModHmrController) {
          return;
        }
        if (paths.length === 0) return;
        await context.selfModHmrController.recordWrite(
          lifecycleRunId,
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
        const createdPaths = [
          ...(event.fileChanges ?? []),
          ...(event.producedFiles ?? []),
        ]
          .filter((record) => record.kind.type === "add")
          .map((record) => record.path);
        try {
          await recordWritePaths(
            paths,
            createdPaths.length > 0 ? { createdPaths } : undefined,
          );
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
          if (!shellGuardActive && agentType !== AGENT_IDS.INSTALL_UPDATE) {
            return {
              error:
                "Self-mod HMR shell guard failed before running a mutating shell command.",
            };
          }
          if (!shellGuardActive) {
            console.warn(
              "[self-mod-hmr] shell mutation guard unavailable for install-update; running bounded update command without HMR guard.",
            );
          }
        }
        try {
          const preWritePaths = inferPreWritePaths(toolName, args, ctx);
          if (preWritePaths.length > 0) {
            try {
              await recordWritePaths(preWritePaths, {
                captureSnapshot: false,
              });
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
          // Remember every shell session this run touched so finalize can
          // sweep background/long-running commands that completed after their
          // last poll for undrained produced files.
          if (shellSessionId) touchedShellSessions.add(shellSessionId);
          if (shellState?.sessionId)
            touchedShellSessions.add(shellState.sessionId);
          if (isParallelWithShellCommands) {
            for (const sessionId of getParallelRunningShellSessions(result)) {
              touchedShellSessions.add(sessionId);
            }
          }
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
            includeDeferred: true,
            // A subagent runs a top-level General's toolset minus the
            // orchestration tools, so it cannot open a third level or steer a
            // sibling thread.
            parentOwned: Boolean(agentContext.parentAgentId),
          }),
          toolExecutor: hmrAwareToolExecutor,
          deviceId: context.deviceId,
          stellaDataDir: context.stellaDataDir,
          resolvedLlm,
          describeImages: createRunnerImageDescriptionService(
            context,
            resolvedLlm,
          ),
          store: context.runtimeStore,
          abortSignal,
          stellaAppDir: context.stellaAppDir,
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
              stellaAppDir: context.stellaDataDir,
              // Honor any per-agent override the user set for this
              // subsidiary agent (or our Assistant-tab propagation would
              // silently hit Stella even when the user moved Assistant
              // onto BYOK).
              modelName: getModelOverride(
                context.stellaDataDir,
                subsidiaryAgentType,
              ),
              agentType: subsidiaryAgentType,
              site: {
                baseUrl: context.state.convexSiteUrl,
                getAuthToken: () => context.state.authToken?.trim(),
                hasConnectedAccount: () => context.state.hasConnectedAccount,
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
                      ...(taskDescription
                        ? { description: taskDescription }
                        : {}),
                    });
                  },
                  onError: (event) => runnerCallbacks.onError(event),
                  onInterrupted: (event) =>
                    runnerCallbacks.onInterrupted?.(event),
                  onEnd: (event) => runnerCallbacks.onEnd(event),
                }
              : {}),
            onStatus: (event) => {
              onStatus?.(event);
            },
            onToolStart: (event) => {
              onToolStart?.(event);
              runnerCallbacks?.onToolStart(event);
            },
            onToolEnd: (event) => {
              onToolEnd?.(event);
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
              // Stamp the spawned agent's thread id onto the tool-end event
              // so the persisted `tool_result` payload carries `agentId` —
              // that's what lets the left sidebar attribute files to this
              // agent's Activity row live, before the completion rollup.
              runnerCallbacks?.onToolEnd(
                agentId ? { ...event, agentId } : event,
              );
            },
          },
          hookEmitter: context.hookEmitter,
        });
        subagentSucceeded =
          !result.error && !result.interrupted && !abortSignal.aborted;
        subagentInterrupted = Boolean(result.interrupted);
        // Late/background flush: long-running shell commands (e.g. video
        // renders) can finish after the model's last poll, so their produced
        // files were never drained inline and would ride only individual
        // tool_result entries — missing from the completion rollup that both
        // desktop and mobile source exclusively. Sweep the sessions this run
        // touched for completed-but-unreported deliverables and merge them
        // (dedup + noise/MAX guards preserved by the shell drain) before the
        // rollup assembles off `result.producedFiles`.
        if (touchedShellSessions.size > 0) {
          try {
            const lateProducedFiles =
              await context.toolHost.drainCompletedShellProducedFiles([
                ...touchedShellSessions,
              ]);
            if (lateProducedFiles.length > 0) {
              collectProducedFiles(
                subagentProducedFiles,
                subagentProducedFileKeys,
                { producedFiles: lateProducedFiles },
              );
              pendingToolWriteRecords.push(
                recordToolWrites({ producedFiles: lateProducedFiles }),
              );
            }
          } catch (error) {
            console.warn(
              "[produced-files] late background shell drain failed (continuing):",
              (error as Error).message,
            );
          }
        }
        // External engines report native/ambient writes on the final result,
        // while Stella tools report incrementally through tool-end events.
        // Union both sources: the old all-or-nothing branch discarded the
        // external half whenever even one Stella tool had also written.
        const resultFileChanges = [...(result.fileChanges ?? [])];
        const resultProducedFiles = [...(result.producedFiles ?? [])];
        for (const change of resultFileChanges) {
          const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? (change.kind.move_path ?? "") : ""}`;
          if (subagentFileChangeKeys.has(key)) continue;
          subagentFileChangeKeys.add(key);
          subagentFileChanges.push(change);
        }
        for (const file of resultProducedFiles) {
          const key = `${file.kind.type}:${file.path}:${file.kind.type === "update" ? (file.kind.move_path ?? "") : ""}`;
          if (subagentProducedFileKeys.has(key)) continue;
          subagentProducedFileKeys.add(key);
          subagentProducedFiles.push(file);
        }
        if (subagentFileChanges.length > 0) {
          result.fileChanges = subagentFileChanges;
        }
        if (subagentProducedFiles.length > 0) {
          result.producedFiles = subagentProducedFiles;
        }
        if (resultFileChanges.length > 0 || resultProducedFiles.length > 0) {
          // Always refresh HMR from the external engine's terminal state,
          // even when an identical path/kind was already seen through a
          // Stella tool. Native work may have edited that same file again.
          pendingToolWriteRecords.push(
            recordToolWrites({
              fileChanges: resultFileChanges,
              producedFiles: resultProducedFiles,
            }),
          );
        }
        return result;
      } finally {
        subagentInterrupted = subagentInterrupted || abortSignal.aborted;
        if (pendingToolWriteRecords.length > 0) {
          await Promise.allSettled(pendingToolWriteRecords);
        }
        if (hasGuardedShellSessions()) {
          await killGuardedShellSessions();
        }
        await releaseGuardedShellSessions();
        armBackgroundExitWake({
          agentType,
          agentId,
          conversationId,
          touchedSessionIds: [...touchedShellSessions],
          interrupted: subagentInterrupted,
          listRunningShellSessionIds:
            context.toolHost.listRunningShellSessionIds,
          listRunningShellSessionsOwnedBy:
            context.toolHost.listRunningShellSessionsOwnedBy,
          ...(context.state.backgroundExitWake
            ? { backgroundExitWake: context.state.backgroundExitWake }
            : {}),
        });
        const shouldKeepMutationEpoch = Boolean(
          shouldAttachSelfModLifecycle &&
          subagentInterrupted &&
          shouldContinueSelfModLifecycleAfterInterrupt?.(),
        );
        if (shouldAttachSelfModLifecycle) {
          try {
            // The finalize/cancel hooks below own the entire apply pipeline
            // (contention tracker drain, Vite overlay swap, runtime restart,
            // morph cover). The renderer no longer participates in the
            // resume-flush dance — it just observes self-mod-hmr state events
            // emitted by the worker server.
            if (subagentSucceeded) {
              // The commit subject is one line of derived text, so it runs as
              // a single stateless completion on the engine-aware light tier —
              // no session, no thread history, no tools, no run events. The
              // prompt already carries everything that decides the subject
              // (task, changed files, truncated diff), so re-sending this
              // thread's transcript would buy nothing. A failure here is not
              // fatal: the finalizer falls back to the task description.
              const commitMessageProvider = createCommitSubjectProvider(
                async (prompt) => {
                  const route = await resolveRunnerRecallLlmRoute(
                    context,
                    agentType,
                    agentContext.modelConfigSnapshot,
                  );
                  return await runLightTextCompletion({
                    route,
                    userPrompt: prompt,
                    agentType,
                    stellaAppDir: context.stellaAppDir,
                    stellaDataDir: context.stellaDataDir,
                    maxOutputTokens: COMMIT_SUBJECT_MAX_OUTPUT_TOKENS,
                    ...(abortSignal ? { signal: abortSignal } : {}),
                  });
                },
              );

              // Durable feature identity, decided at write time: an explicit
              // identity from the caller, else the authoring thread key, so a
              // thread resumed later keeps extending the same feature.
              const threadName =
                !selfModFeature && agentId
                  ? context.runtimeStore.getThreadName?.(agentId)
                  : undefined;
              const featureId = selfModFeature?.featureId ?? agentId;
              const featureTitle =
                selfModFeature?.featureTitle ??
                (threadName && threadName !== agentId
                  ? threadName
                  : taskDescription);

              await Promise.resolve(
                context.selfModLifecycle!.finalizeRun({
                  runId: lifecycleRunId,
                  ...(rootRunId ? { rootRunId } : {}),
                  taskDescription,
                  taskPrompt,
                  conversationId,
                  ...(agentId ? { threadKey: agentId } : {}),
                  ...((agentContext.parentAgentId ?? agentId)
                    ? { ownerThreadId: agentContext.parentAgentId ?? agentId }
                    : {}),
                  ...(featureId ? { featureId } : {}),
                  ...(featureTitle ? { featureTitle } : {}),
                  succeeded: true,
                  commitMessageProvider,
                }),
              );
              onSelfModRunClosed?.(lifecycleRunId);
            } else if (shouldKeepMutationEpoch) {
              // This interrupt is a continuation boundary, not terminal
              // cancellation. Keep the self-mod run open so writes before and
              // after the boundary apply as one batch when the task finishes.
            } else if (
              typeof context.selfModLifecycle!.cancelRun === "function"
            ) {
              await Promise.resolve(
                context.selfModLifecycle!.cancelRun(lifecycleRunId),
              );
              onSelfModRunClosed?.(lifecycleRunId);
            }
          } finally {
            if (!shouldKeepMutationEpoch) {
              await closeMutationEpoch();
            }
          }
        } else {
          await closeMutationEpoch();
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
    saveAgentRecord: (record) => {
      context.runtimeStore.saveAgentRecord?.(record);
      // Every thread transition funnels through here — this push is what
      // keeps the renderer's authoritative Activity store current.
      context.notifyThreadActivityUpdated?.(record.conversationId);
    },
    getAgentRecord: (threadId) =>
      context.runtimeStore.getAgentRecord?.(threadId) ?? null,
    listAgentRecordsByStatus: (status) =>
      context.runtimeStore.listAgentRecordsByStatus?.(status) ?? [],
    hasAgentLifecycleEvent: (conversationId, eventId, type) => {
      const hasHiddenDelivery = hasPersistedThreadCustomEvent(
        context,
        resolveOrchestratorThreadKey(conversationId),
        eventId,
      );
      return (
        context.runtimeStore.hasEvent(conversationId, eventId, type) &&
        hasHiddenDelivery
      );
    },
  });
  context.state.localAgentManager.repairInterruptedDescendantBoundaries();

  // A child terminal row may survive a crash after its report was persisted
  // but before the owning parent durably consumed the wake. Replay only
  // unacknowledged child boundaries. The parent's persisted event-id fence
  // covers the narrow crash window after parent delivery but before this
  // child row receives its acknowledgement.
  for (const status of ["completed", "error", "canceled"] as const) {
    for (const record of context.runtimeStore.listAgentRecordsByStatus?.(
      status,
    ) ?? []) {
      if (!record.parentAgentId) continue;
      const type =
        status === "completed"
          ? "agent-completed"
          : status === "error"
            ? "agent-failed"
            : "agent-canceled";
      const eventId = `${record.threadId}:${record.attemptGeneration}:${type}`;
      // Absence is deliberately settled for migration safety: legacy child
      // rows predate this handshake and must never all replay on upgrade.
      if (record.descendantBoundaryState?.parentWakePendingEventId !== eventId)
        continue;
      handleAgentLifecycleEvent({
        type,
        conversationId: record.conversationId,
        eventId,
        rootRunId: record.rootRunId,
        agentId: record.threadId,
        agentType: record.agentType,
        description: record.description,
        parentAgentId: record.parentAgentId,
        attemptGeneration: record.attemptGeneration,
        ...(status === "completed" ? { result: record.result } : {}),
        ...(status !== "completed" ? { error: record.error } : {}),
      });
    }
  }

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
      // Event-driven settlement: terminal transitions wake this loop
      // immediately via the manager's update notifier; the 2s fallback
      // covers rehydrated records and out-of-band writers (SQLite stays
      // the only truth — every wake re-reads the snapshot above).
      await context.state.localAgentManager.waitForAgentUpdate(threadId);
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
    // Do not release active epochs ahead of asynchronous engine teardown.
    // Each aborted run releases from its finally block; a hard worker exit
    // leaves a pid-owned ticket that the successor safely reclaims only after
    // this worker is dead.
  };

  return {
    runBlockingLocalAgent,
    createBackgroundAgent,
    cancelLocalAgent,
    shutdown,
  };
};
