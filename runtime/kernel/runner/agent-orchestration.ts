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
  buildCommitSubjectPrompt,
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
  const groupFields = event.groupKey
    ? {
        groupKey: event.groupKey,
        ...(event.groupLabel ? { groupLabel: event.groupLabel } : {}),
      }
    : {};
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
        ...groupFields,
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
        ...groupFields,
      };
    case "agent-message":
      return {
        agentId: event.agentId,
        ...runFields,
        ...(typeof event.attemptGeneration === "number"
          ? { attemptGeneration: event.attemptGeneration }
          : {}),
        result: event.result ?? "",
        ...(event.description ? { description: event.description } : {}),
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
        ...groupFields,
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
        ...groupFields,
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

const isCardLifecycleEvent = (
  event: AgentLifecycleEvent,
): event is AgentLifecycleEvent & {
  type:
    | "agent-started"
    | "agent-progress"
    | "agent-completed"
    | "agent-failed"
    | "agent-canceled";
} => event.type !== "agent-message";

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
  const handleAgentLifecycleEvent = (rawEvent: AgentLifecycleEvent) => {
    // Enrich every lifecycle event with its thread's work group ONCE,
    // centrally — emit sites in the manager stay group-unaware. The
    // Activity UI uses this to collapse sibling agents under one group
    // header.
    let event = rawEvent;
    if (!event.groupKey) {
      // Optional-chained like the other runtimeStore lookups here: test
      // harnesses stub partial stores.
      const group = context.runtimeStore.getThreadGroup?.(event.agentId);
      if (group?.groupKey) {
        event = {
          ...event,
          groupKey: group.groupKey,
          ...(group.groupLabel ? { groupLabel: group.groupLabel } : {}),
        };
      }
    }
    const managerOwner =
      context.state.localAgentManager?.resolveOwningManagerThread(
        event.agentId,
        event.parentAgentId,
      );
    const managerParentId =
      typeof managerOwner === "string" ? managerOwner : undefined;
    const isManagerOwned = managerParentId !== undefined;
    const hasUnresolvedManagedAncestry = managerOwner === null;
    // Interjection-turn completions arrive twice (see
    // `AgentLifecycleEvent.audience`): `orchestrator-only` skips every
    // display surface (persisted activity row, renderer/run callbacks,
    // OS notification) so the task UI keeps reading "in progress",
    // while the deferred `display-only` replay skips the hidden
    // orchestrator follow-up that already went out.
    if (
      event.audience !== "orchestrator-only" &&
      !isManagerOwned &&
      !hasUnresolvedManagedAncestry
    ) {
      // Progress ticks are ephemeral decoration: they stream to the renderer
      // below but are never persisted — thread state lives in
      // `runtime_agents` (see `listThreadActivity`), and persisting every
      // tick grew the message table without bound.
      if (event.type !== "agent-progress" && event.type !== "agent-message") {
        appendAgentLifecycleChatEvent(context, event);
      }
      if (event.rootRunId) {
        context.state.runCallbacksByRunId
          .get(event.rootRunId)
          ?.onAgentEvent?.(event);
      }
    }
    if (
      managerParentId &&
      event.audience !== "orchestrator-only" &&
      isCardLifecycleEvent(event)
    ) {
      // Manager descendants stay out of the root event table, but their own
      // exact-thread viewer still needs the canonical lifecycle semantics.
      // Store a display-only structured entry beside (not inside) the
      // model-visible terminal reminder. Starts/progress have no reminder at
      // all, and this entry type is never replayed into Manager context.
      const lifecycleEvent = buildThreadLifecycleEvent(event, Date.now());
      if (
        !context.runtimeStore.hasThreadLifecycleEvent(
          managerParentId,
          lifecycleEvent._id,
        )
      ) {
        context.runtimeStore.appendThreadLifecycleEvent({
          threadKey: managerParentId,
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
    if (hasUnresolvedManagedAncestry) return;
    const userPrompt = buildAgentEventPrompt(event, {
      recipient: isManagerOwned ? "manager" : "orchestrator",
    });
    if (!userPrompt) {
      return;
    }
    if (managerParentId) {
      // Managed child reports live in the manager's durable thread and wake
      // that manager directly. They never enter the top-level orchestrator's
      // history, callbacks, or hidden follow-up stream.
      if (
        hasPersistedThreadCustomEvent(context, managerParentId, event.eventId)
      ) {
        return;
      }
      persistThreadCustomMessage(context.runtimeStore, {
        threadKey: managerParentId,
        customType: "runtime.task_lifecycle",
        content: [{ type: "text", text: userPrompt }],
        display: false,
        timestamp: Date.now(),
        ...(event.eventId ? { eventId: event.eventId } : {}),
      });
      void context.state.localAgentManager?.sendAgentMessage(
        managerParentId,
        userPrompt,
        "orchestrator",
        { deliveryKind: "manager-event" },
      );
      return;
    }
    // The follow-up below is in-memory delivery for the active orchestrator
    // session; this row is the durable record read by the next history rebuild.
    const isInterimMessage = event.type === "agent-message";
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
        customType: isInterimMessage
          ? "runtime.task_update"
          : "runtime.task_lifecycle",
        content: [{ type: "text", text: userPrompt }],
        display: false,
        timestamp: Date.now(),
        ...(event.eventId ? { eventId: event.eventId } : {}),
      });
    }
    void deps.sendMessage({
      conversationId: event.conversationId,
      text: userPrompt,
      uiVisibility: "hidden",
      agentType: AGENT_IDS.ORCHESTRATOR,
      deliverAs: "followUp",
      callbackRunId: event.rootRunId,
      customType: isInterimMessage
        ? "runtime.task_update"
        : "runtime.task_lifecycle",
      display: false,
      responseTarget: createAgentLifecycleResponseTarget({
        agentId: event.agentId,
        eventType: event.type,
      }),
    });
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
    listGroupMemberThreadIds: (groupKey) =>
      context.runtimeStore.listGroupMemberThreadIds(groupKey),
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

      if (shouldAttachSelfModLifecycle) {
        // Register the run with the contention tracker before any writes can
        // arrive. recordWrite is a no-op on unknown runs to avoid resurrecting
        // already-finalized runs, so beginRun must precede writes.
        if (!isContinuingSelfModRun) {
          await context.selfModHmrController?.beginRun(lifecycleRunId);
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
      let exploreFindingsBlock = "";
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
      // Reporting scope for the Dream-inbox row this run records: only a
      // child with verified orchestrator-reporting ancestry (the ownership
      // walk returns `undefined` — a string is a manager owner whose thread
      // gets the report instead of the orchestrator window; `null` is
      // unresolved ancestry that reports nowhere) may be stamped with the
      // conversation. Anything unverifiable stays unstamped, so its inbox
      // row keeps a NULL conversation and is only ever consumed by the
      // model-driven Dream list path — never delta-covered mechanically.
      const managedAncestry =
        agentId && context.state.localAgentManager
          ? context.state.localAgentManager.resolveOwningManagerThread(agentId)
          : null;
      const dreamReportingConversationId =
        managedAncestry === undefined ? conversationId : undefined;
      try {
        const result = await runSubagentTask({
          conversationId,
          userMessageId,
          runId,
          agentId,
          rootRunId,
          agentType,
          userPrompt: composedUserPrompt,
          ...(dreamReportingConversationId
            ? { dreamReportingConversationId }
            : {}),
          selfModMetadata: effectiveSelfModMetadata,
          agentContext,
          toolCatalog: context.toolHost.getToolCatalog(agentType, {
            model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
            agentEngine: agentContext.agentEngine,
            includeDeferred: true,
          }),
          toolExecutor: hmrAwareToolExecutor,
          deviceId: context.deviceId,
          stellaDataDir: context.stellaDataDir,
          resolvedLlm,
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
        if (subagentFileChanges.length > 0) {
          result.fileChanges = subagentFileChanges;
        }
        if (subagentProducedFiles.length > 0) {
          result.producedFiles = subagentProducedFiles;
        }
        const hasCollectedToolWrites =
          subagentFileChanges.length > 0 || subagentProducedFiles.length > 0;
        if (
          !hasCollectedToolWrites &&
          (result.fileChanges?.length || result.producedFiles?.length)
        ) {
          // External engines report writes on the final run result instead of
          // emitting Stella tool-end events, so bridge those deltas into the
          // self-mod lifecycle here.
          pendingToolWriteRecords.push(
            recordToolWrites({
              fileChanges: result.fileChanges,
              producedFiles: result.producedFiles,
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
              const oneShotResolvedLlm =
                oneShotContext.resolvedLlm ?? resolvedLlm;
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
                stellaDataDir: context.stellaDataDir,
                ...(context.cliBridgeSocketPath
                  ? { cliBridgeSocketPath: context.cliBridgeSocketPath }
                  : {}),
                resolvedLlm: oneShotResolvedLlm,
                store: context.runtimeStore,
                suppressCompletionSideEffects: true,
                compactionScheduler: context.state.compactionScheduler,
                ...(abortSignal ? { abortSignal } : {}),
                stellaAppDir: context.stellaAppDir,
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

            // Durable feature identity, decided at write time: an explicit
            // identity from the caller, else the authoring thread's group
            // key (several agents serving one request commit to ONE
            // feature), else its thread key — so a thread resumed months
            // later keeps extending the same feature instead of spawning a
            // churned rename.
            const threadGroup =
              !selfModFeature && agentId
                ? context.runtimeStore.getThreadGroup?.(agentId)
                : undefined;
            const threadName =
              !selfModFeature && agentId
                ? context.runtimeStore.getThreadName?.(agentId)
                : undefined;
            const featureId =
              selfModFeature?.featureId ?? threadGroup?.groupKey ?? agentId;
            const featureTitle =
              selfModFeature?.featureTitle ??
              threadGroup?.groupLabel ??
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
                ...(featureId ? { featureId } : {}),
                ...(featureTitle ? { featureTitle } : {}),
                succeeded: true,
                commitMessageProvider,
              }),
            );
            onSelfModRunClosed?.(lifecycleRunId);
          } else if (
            subagentInterrupted &&
            shouldContinueSelfModLifecycleAfterInterrupt?.()
          ) {
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
    hasAgentLifecycleEvent: (conversationId, eventId, type) =>
      context.runtimeStore.hasEvent(conversationId, eventId, type) &&
      hasPersistedThreadCustomEvent(
        context,
        resolveOrchestratorThreadKey(conversationId),
        eventId,
      ),
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
