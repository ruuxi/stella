import {
  ipcMain,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import crypto from "node:crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  isTaskLifecycleEventType,
  shouldIgnoreTerminalTaskFeedEvent,
  type AgentIdLike,
  type AgentRunFinishOutcome,
  type AgentStreamEventType,
  type TaskLifecycleStatus,
} from "../../../runtime/contracts/agent-runtime.js";
import type { SelfModHmrState } from "../../../runtime/contracts/index.js";
import { IPC_AGENT_ONE_SHOT_COMPLETION } from "../../src/shared/contracts/ipc-channels.js";
import type {
  RuntimeOneShotCompletionRequest,
  RuntimeOneShotCompletionResult,
} from "../../../runtime/protocol/index.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { createMonotonicSeqGenerator } from "./monotonic-seq.js";
import { getFileLogger } from "../../../runtime/observability/file-logger.js";

type AgentHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  getAppSessionStartedAt: () => number;
  isHostAuthAuthenticated: () => boolean;
  stellaAppDir: string;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getBroadcastToMobile?: () =>
    | ((channel: string, data: unknown) => void)
    | null;
};

type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  chunk?: string;
  statusState?: "running" | "compacting" | "provider-retry";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: {
    commitHash: string;
    files: string[];
    batchIndex: number;
    status?: "pending" | "applied";
  };
  agentId?: string;
  agentType?: AgentIdLike;
  rootRunId?: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  /** Work group (`grp-…` key + human label) of the agent's thread. */
  groupKey?: string;
  groupLabel?: string;
};

type ActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
};

type ConversationTaskSnapshot = {
  runId: string;
  agentId: string;
  agentType?: string;
  description?: string;
  anchorTurnId?: string;
  parentAgentId?: string;
  status: TaskLifecycleStatus;
  statusText?: string;
  reasoningText?: string;
  result?: string;
  error?: string;
  groupKey?: string;
  groupLabel?: string;
};

const MAX_AGENT_REASONING_CHARS = 8_000;

type SelfModHmrStatePayload = SelfModHmrState;

const redactSensitiveLogText = (value: string) =>
  value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-token]")
    .replace(/\b(Bearer\s+[A-Za-z0-9._-]{12,})\b/gi, "[redacted-token]")
    .replace(
      /\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{10,})\b/g,
      "[redacted-token]",
    );

const AGENT_EVENT_BUFFER_LIMIT = 1000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1000;
/**
 * How long a client-supplied idempotency key (`clientRequestId`) maps to a
 * started run. A reconnecting client (e.g. mobile over a flaky tunnel) can
 * safely re-send the same `startChat` within this window without spawning a
 * duplicate run; we just hand back the original `requestId`.
 */
const CLIENT_REQUEST_DEDUPE_TTL_MS = 5 * 60 * 1000;

export const registerAgentHandlers = (options: AgentHandlersOptions) => {
  const runOwners = new Map<string, number>();
  const requestOwners = new Map<string, number>();
  const runToConversationId = new Map<string, string>();
  const runToRequestId = new Map<string, string>();
  const requestToRunId = new Map<string, string>();
  const terminalRunIds = new Set<string>();
  const activeRunByConversation = new Map<string, ActiveRunSnapshot>();
  const tasksByRunId = new Map<string, Map<string, ConversationTaskSnapshot>>();
  const nextAgentEventSeq = createMonotonicSeqGenerator();
  const conversationEventBuffers = new Map<
    string,
    {
      events: AgentEventPayload[];
      updatedAt: number;
    }
  >();
  const clientRequestIndex = new Map<
    string,
    { requestId: string; createdAt: number }
  >();
  const clientRequestKeyByRequestId = new Map<string, string>();

  const pruneClientRequestIndex = () => {
    const now = Date.now();
    for (const [key, entry] of clientRequestIndex) {
      if (now - entry.createdAt > CLIENT_REQUEST_DEDUPE_TTL_MS) {
        clientRequestIndex.delete(key);
        clientRequestKeyByRequestId.delete(entry.requestId);
      }
    }
  };

  const pruneConversationEventBuffers = () => {
    const now = Date.now();
    for (const [conversationId, buffer] of conversationEventBuffers.entries()) {
      if (activeRunByConversation.has(conversationId)) continue;
      if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
        conversationEventBuffers.delete(conversationId);
      }
    }
  };

  const bufferConversationEvent = (
    conversationId: string,
    event: AgentEventPayload,
  ) => {
    const existing = conversationEventBuffers.get(conversationId);
    if (existing) {
      existing.events.push(event);
      if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
        existing.events.splice(
          0,
          existing.events.length - AGENT_EVENT_BUFFER_LIMIT,
        );
      }
      existing.updatedAt = Date.now();
      return;
    }

    conversationEventBuffers.set(conversationId, {
      events: [event],
      updatedAt: Date.now(),
    });
  };

  const resolveReceiverId = (
    event: Pick<AgentEventPayload, "runId" | "requestId">,
    targetWebContentsId?: number,
  ): number | undefined => {
    if (typeof targetWebContentsId === "number") {
      return targetWebContentsId;
    }
    if (event.requestId) {
      const requestOwner = requestOwners.get(event.requestId);
      if (typeof requestOwner === "number") {
        return requestOwner;
      }
    }
    const runOwner = runOwners.get(event.runId);
    return typeof runOwner === "number" ? runOwner : undefined;
  };

  const upsertTaskSnapshot = (event: AgentEventPayload) => {
    if (!event.agentId) return;
    const isReasoning = event.type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING;
    if (!isReasoning && !isTaskLifecycleEventType(event.type)) return;

    const runId = event.rootRunId ?? event.runId;
    const runTasks =
      tasksByRunId.get(runId) ?? new Map<string, ConversationTaskSnapshot>();
    const current = runTasks.get(event.agentId);
    const base: ConversationTaskSnapshot = {
      runId,
      agentId: event.agentId,
      agentType: event.agentType ?? current?.agentType,
      description: event.description ?? current?.description,
      anchorTurnId: event.userMessageId ?? current?.anchorTurnId,
      parentAgentId: event.parentAgentId ?? current?.parentAgentId,
      status: current?.status ?? "running",
      statusText: current?.statusText,
      reasoningText: current?.reasoningText,
      result: current?.result,
      error: current?.error,
      groupKey: event.groupKey ?? current?.groupKey,
      groupLabel: event.groupLabel ?? current?.groupLabel,
    };

    if (
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: current?.status,
        eventType: event.type as Parameters<
          typeof shouldIgnoreTerminalTaskFeedEvent
        >[0]["eventType"],
      })
    ) {
      return;
    }

    switch (event.type) {
      case AGENT_STREAM_EVENT_TYPES.AGENT_STARTED:
        base.status = "running";
        base.statusText = event.statusText ?? current?.statusText;
        base.reasoningText = "";
        base.result = undefined;
        base.error = undefined;
        break;
      case AGENT_STREAM_EVENT_TYPES.AGENT_REASONING: {
        base.status = "running";
        base.result = undefined;
        base.error = undefined;
        const merged = `${current?.reasoningText ?? ""}${event.chunk ?? ""}`;
        base.reasoningText =
          merged.length > MAX_AGENT_REASONING_CHARS
            ? merged.slice(-MAX_AGENT_REASONING_CHARS)
            : merged;
        break;
      }
      case AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS:
        base.status = "running";
        base.statusText = event.statusText ?? current?.statusText;
        base.result = undefined;
        base.error = undefined;
        break;
      case AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED:
        base.status = "completed";
        base.statusText = undefined;
        base.result = event.result;
        base.error = undefined;
        break;
      case AGENT_STREAM_EVENT_TYPES.AGENT_FAILED:
        base.status = "error";
        base.statusText = undefined;
        base.result = undefined;
        base.error = event.error;
        break;
      case AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED:
        base.status = "canceled";
        base.statusText = undefined;
        base.result = undefined;
        base.error = event.error;
        break;
    }

    runTasks.set(event.agentId, base);
    tasksByRunId.set(runId, runTasks);
    console.log(
      JSON.stringify({
        label: "[stella:working-indicator:ipc-task-snapshot]",
        type: event.type,
        runId,
        agentId: event.agentId,
        description: base.description,
        status: base.status,
        statusText: base.statusText,
      }),
    );
  };

  const emitAgentEvent = (
    event: Omit<AgentEventPayload, "seq"> & { seq?: number },
    targetWebContentsId?: number,
  ) => {
    const normalizedEvent: AgentEventPayload = {
      ...event,
      seq: nextAgentEventSeq(),
    };
    const trackedRunId = normalizedEvent.rootRunId ?? normalizedEvent.runId;

    runToConversationId.set(trackedRunId, normalizedEvent.conversationId);
    if (normalizedEvent.requestId) {
      runToRequestId.set(trackedRunId, normalizedEvent.requestId);
    }
    if (typeof targetWebContentsId === "number") {
      runOwners.set(trackedRunId, targetWebContentsId);
    }

    if (normalizedEvent.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
      const activeRun = activeRunByConversation.get(
        normalizedEvent.conversationId,
      );
      if (activeRun?.runId === normalizedEvent.runId) {
        activeRunByConversation.delete(normalizedEvent.conversationId);
      }
      tasksByRunId.delete(trackedRunId);
    } else {
      upsertTaskSnapshot(normalizedEvent);
    }

    bufferConversationEvent(normalizedEvent.conversationId, normalizedEvent);
    pruneConversationEventBuffers();

    options.getBroadcastToMobile?.()?.("agent:event", normalizedEvent);
    const receiverId = resolveReceiverId(normalizedEvent, targetWebContentsId);
    if (receiverId == null) {
      return;
    }
    const receiver = webContents.fromId(receiverId);
    if (receiver && !receiver.isDestroyed()) {
      receiver.send("agent:event", normalizedEvent);
    }
  };

  const scheduleRunCleanup = (runId: string, requestId?: string) => {
    setTimeout(() => {
      const runTasks = tasksByRunId.get(runId);
      const hasRunningTasks = Array.from(runTasks?.values() ?? []).some(
        (task) => task.status === "running",
      );
      if (hasRunningTasks) {
        scheduleRunCleanup(runId, requestId);
        return;
      }
      runOwners.delete(runId);
      runToConversationId.delete(runId);
      tasksByRunId.delete(runId);
      terminalRunIds.delete(runId);
      const linkedRequestId = requestId ?? runToRequestId.get(runId);
      if (linkedRequestId) {
        requestOwners.delete(linkedRequestId);
        requestToRunId.delete(linkedRequestId);
        runToRequestId.delete(runId);
        const clientRequestKey =
          clientRequestKeyByRequestId.get(linkedRequestId);
        if (clientRequestKey) {
          clientRequestIndex.delete(clientRequestKey);
          clientRequestKeyByRequestId.delete(linkedRequestId);
        }
      }
      pruneConversationEventBuffers();
    }, 60_000);
  };

  const emitSelfModHmrState = (
    payload: SelfModHmrStatePayload,
    targetWebContentsId?: number,
  ) => {
    options.getBroadcastToMobile?.()?.("agent:selfModHmrState", payload);
    const receiverId = targetWebContentsId;
    if (receiverId == null) {
      return;
    }
    const receiver = webContents.fromId(receiverId);
    if (receiver && !receiver.isDestroyed()) {
      receiver.send("agent:selfModHmrState", payload);
    }
  };

  ipcMain.handle(
    IPC_AGENT_ONE_SHOT_COMPLETION,
    async (
      _event,
      payload: RuntimeOneShotCompletionRequest,
    ): Promise<RuntimeOneShotCompletionResult> => {
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime is not ready.");
      }
      return await stellaHostRunner.runOneShotCompletion(payload);
    },
  );

  ipcMain.handle("agent:healthCheck", async () => {
    const stellaHostRunner = options.getStellaHostRunner();
    if (!stellaHostRunner) {
      return null;
    }
    const rawResult = await stellaHostRunner.agentHealthCheck();
    const result =
      rawResult?.ready === false &&
      rawResult.reason === "Missing auth token" &&
      !options.isHostAuthAuthenticated()
        ? { ...rawResult, reason: "Awaiting auth token" }
        : rawResult;

    return result;
  });

  ipcMain.handle("agent:getActiveRun", async () => {
    const stellaHostRunner = options.getStellaHostRunner();
    if (!stellaHostRunner) return null;
    const health = await stellaHostRunner.agentHealthCheck();
    if (!health?.ready) return null;
    return await stellaHostRunner.getActiveOrchestratorRun();
  });

  ipcMain.handle("agent:getAppSessionStartedAt", async () => {
    return options.getAppSessionStartedAt();
  });

  ipcMain.handle(
    "agent:resume",
    async (event, payload: { conversationId: string; lastSeq: number }) => {
      pruneConversationEventBuffers();
      const conversationId =
        typeof payload.conversationId === "string"
          ? payload.conversationId.trim()
          : "";
      const lastSeq = Number.isFinite(payload.lastSeq) ? payload.lastSeq : 0;
      if (!conversationId) {
        return {
          activeRun: null,
          events: [] as AgentEventPayload[],
          tasks: [] as ConversationTaskSnapshot[],
        };
      }
      const buffer = conversationEventBuffers.get(conversationId);
      let activeRun = activeRunByConversation.get(conversationId) ?? null;
      let resumeRunId = activeRun?.runId ?? null;
      if (!resumeRunId) {
        const stellaHostRunner = options.getStellaHostRunner();
        const discovered = await stellaHostRunner
          ?.listActiveRuns()
          .catch(() => ({ runs: [] }));
        const match = discovered?.runs.find(
          (run) => run.conversationId === conversationId,
        );
        if (match) {
          resumeRunId = match.runId;
          if (match.kind === "active") {
            activeRun = {
              runId: match.runId,
              conversationId,
              ...(match.uiVisibility
                ? { uiVisibility: match.uiVisibility }
                : {}),
            };
            activeRunByConversation.set(conversationId, activeRun);
          }
          runToConversationId.set(match.runId, conversationId);
        }
      }
      const bufferedEvents = buffer
        ? buffer.events.filter((agentEvent) => agentEvent.seq > lastSeq)
        : [];
      let events = bufferedEvents;
      if (resumeRunId && events.length === 0) {
        const stellaHostRunner = options.getStellaHostRunner();
        if (stellaHostRunner) {
          try {
            const replay = await stellaHostRunner.resumeRunEvents({
              runId: resumeRunId,
              lastSeq,
            });
            if (!replay.exhausted) {
              events = replay.events.map((event) => ({
                ...event,
                type: event.type as AgentStreamEventType,
                conversationId: event.conversationId ?? conversationId,
              }));
            }
          } catch {
            // Resume can still hydrate from local chat and task snapshots.
          }
        }
      }
      const resumedRequestId =
        activeRun?.requestId ??
        events.find((agentEvent) => typeof agentEvent.requestId === "string")
          ?.requestId ??
        (resumeRunId ? runToRequestId.get(resumeRunId) : undefined);
      if (resumeRunId && activeRun) {
        const stellaHostRunner = options.getStellaHostRunner();
        const senderWebContentsId = event.sender.id;
        const requestId =
          resumedRequestId ?? `resume:${conversationId}:${resumeRunId}`;
        activeRun = {
          ...activeRun,
          requestId,
        };
        activeRunByConversation.set(conversationId, activeRun);
        runOwners.set(resumeRunId, senderWebContentsId);
        runToConversationId.set(resumeRunId, conversationId);
        runToRequestId.set(resumeRunId, requestId);
        requestOwners.set(requestId, senderWebContentsId);
        requestToRunId.set(requestId, resumeRunId);
        stellaHostRunner?.attachResumedLocalChatSession(
          {
            conversationId,
            runId: resumeRunId,
            requestId,
            ...(activeRun.userMessageId
              ? { userMessageId: activeRun.userMessageId }
              : {}),
            ...(activeRun.uiVisibility
              ? { uiVisibility: activeRun.uiVisibility }
              : {}),
            active: true,
          },
          {
            onRunStarted: (ev) => {
              if (ev.uiVisibility === "hidden") {
                return;
              }
              terminalRunIds.delete(ev.runId);
              runOwners.set(ev.runId, senderWebContentsId);
              runToConversationId.set(ev.runId, conversationId);
              runToRequestId.set(ev.runId, requestId);
              requestToRunId.set(requestId, ev.runId);
              activeRunByConversation.set(conversationId, {
                runId: ev.runId,
                conversationId,
                requestId,
                userMessageId: ev.userMessageId,
                uiVisibility: ev.uiVisibility,
              });
              emitAgentEvent(
                {
                  type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
                  runId: ev.runId,
                  conversationId,
                  requestId,
                  ...(ev.userMessageId
                    ? { userMessageId: ev.userMessageId }
                    : {}),
                  ...(ev.uiVisibility ? { uiVisibility: ev.uiVisibility } : {}),
                  ...(ev.agentType ? { agentType: ev.agentType } : {}),
                },
                senderWebContentsId,
              );
            },
            onStream: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.STREAM,
                  conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onAssistantMessage: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
                  conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onStatus: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.STATUS,
                  conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onToolStart: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
                  conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onToolEnd: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
                  conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onRunFinished: (ev) => {
              if (terminalRunIds.has(ev.runId)) {
                return;
              }
              terminalRunIds.add(ev.runId);
              emitAgentEvent(
                {
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  runId: ev.runId,
                  conversationId,
                  requestId,
                  agentType: ev.agentType,
                  userMessageId: ev.userMessageId,
                  finalText: ev.finalText,
                  persisted: ev.persisted,
                  selfModApplied: ev.selfModApplied,
                  error: ev.error,
                  outcome: ev.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
                  reason: ev.reason ?? ev.error,
                },
                senderWebContentsId,
              );
              scheduleRunCleanup(ev.runId, requestId);
            },
            onAgentEvent: (ev) => {
              if (!ev.rootRunId) {
                return;
              }
              emitAgentEvent(
                {
                  type: ev.type,
                  runId: ev.rootRunId,
                  rootRunId: ev.rootRunId,
                  conversationId,
                  requestId,
                  userMessageId: ev.userMessageId,
                  agentId: ev.agentId,
                  agentType: ev.agentType,
                  description: ev.description,
                  parentAgentId: ev.parentAgentId,
                  result: ev.result,
                  error: ev.error,
                  statusText: ev.statusText,
                  groupKey: ev.groupKey,
                  groupLabel: ev.groupLabel,
                },
                senderWebContentsId,
              );
            },
            onAgentReasoning: (ev) => {
              if (!ev.agentId) {
                return;
              }
              const runId = ev.rootRunId ?? ev.runId;
              emitAgentEvent(
                {
                  type: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
                  runId,
                  rootRunId: runId,
                  conversationId,
                  requestId,
                  userMessageId: ev.userMessageId,
                  agentId: ev.agentId,
                  agentType: ev.agentType,
                  chunk: ev.chunk,
                },
                senderWebContentsId,
              );
            },
            onSelfModHmrState: (hmrState) =>
              emitSelfModHmrState(hmrState, senderWebContentsId),
          },
        );
      }
      const tasks = Array.from(tasksByRunId.entries())
        .filter(([runId]) => runToConversationId.get(runId) === conversationId)
        .flatMap(([, taskMap]) => Array.from(taskMap.values()));
      return {
        activeRun,
        events,
        tasks,
      };
    },
  );

  ipcMain.handle(
    "agent:startChat",
    async (
      event,
      payload: {
        conversationId: string;
        userPrompt: string;
        selectedText?: string | null;
        chatContext?:
          | import("../../../runtime/contracts/index.js").ChatContext
          | null;
        deviceId?: string;
        platform?: string;
        timezone?: string;
        locale?: string;
        mode?: string;
        messageMetadata?: Record<string, unknown>;
        attachments?: Array<{
          url: string;
          mimeType?: string;
          previewUrl?: string;
        }>;
        userMessageEventId?: string;
        agentType?: string;
        storageMode?: "cloud" | "local";
        clientRequestId?: string;
        selfModMetadata?: {
          packageId?: string;
          releaseNumber?: number;
          mode?:
            | "author"
            | "install"
            | "update"
            | "uninstall"
            | "desktop-update";
          expectedChangedFiles?: string[];
        };
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "agent:startChat")) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }

      // Idempotent send: a client (e.g. mobile over a flaky tunnel) can retry
      // the same logical message with a stable `clientRequestId`. If we already
      // started a run for it, hand back the original `requestId` instead of
      // spawning a duplicate. Reserve the key before any await so two retries
      // racing through here can't both start a run.
      const clientRequestId =
        typeof payload.clientRequestId === "string"
          ? payload.clientRequestId.trim()
          : "";
      if (clientRequestId) {
        pruneClientRequestIndex();
        const existing = clientRequestIndex.get(clientRequestId);
        if (existing) {
          return { requestId: existing.requestId };
        }
      }

      const senderWebContentsId = event.sender.id;
      const requestId = `req:${crypto.randomUUID()}`;
      requestOwners.set(requestId, senderWebContentsId);
      if (clientRequestId) {
        clientRequestIndex.set(clientRequestId, {
          requestId,
          createdAt: Date.now(),
        });
        clientRequestKeyByRequestId.set(requestId, clientRequestId);
      }
      const releaseClientRequest = () => {
        if (clientRequestId) {
          clientRequestIndex.delete(clientRequestId);
          clientRequestKeyByRequestId.delete(requestId);
        }
      };

      try {
        await stellaHostRunner.waitUntilConnected(5_000);

        // The worker is lazily spawned — startChat will wake it on demand
        // via ensureWorker. Only block here to let a freshly-set auth token
        // propagate; skip if the worker is simply asleep (no reason string).
        const deadline = Date.now() + 5_000;
        let health = await stellaHostRunner.agentHealthCheck();
        while (
          health?.ready === false &&
          health.reason &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 200));
          health = await stellaHostRunner.agentHealthCheck();
        }
        if (health?.ready === false && health.reason) {
          throw new Error(health.reason);
        }
      } catch (error) {
        // Never started a run; let a future retry try again from scratch.
        requestOwners.delete(requestId);
        releaseClientRequest();
        throw error;
      }

      console.log(
        `[stella:trace] IPC agent:startChat | convId=${payload.conversationId} | prompt=${redactSensitiveLogText(payload.userPrompt.slice(0, 200))}`,
      );
      const isInstallUpdateAgent =
        payload.agentType === AGENT_IDS.INSTALL_UPDATE;
      if (isInstallUpdateAgent) {
        getFileLogger()?.process("desktop-update.agent.start-request", {
          requestId,
          conversationId: payload.conversationId,
        });
      }

      const emitRunFinished = (args: {
        runId: string;
        outcome: AgentRunFinishOutcome;
        agentType?: AgentIdLike;
        userMessageId?: string;
        finalText?: string;
        persisted?: boolean;
        selfModApplied?: {
          commitHash: string;
          files: string[];
          batchIndex: number;
          status?: "pending" | "applied";
        };
        error?: string;
        reason?: string;
      }) => {
        if (terminalRunIds.has(args.runId)) {
          return;
        }
        terminalRunIds.add(args.runId);
        emitAgentEvent(
          {
            type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
            runId: args.runId,
            conversationId: payload.conversationId,
            requestId,
            agentType: args.agentType,
            userMessageId: args.userMessageId,
            finalText: args.finalText,
            persisted: args.persisted,
            selfModApplied: args.selfModApplied,
            error: args.error,
            outcome: args.outcome,
            reason: args.reason ?? args.error,
          },
          senderWebContentsId,
        );
        scheduleRunCleanup(args.runId, requestId);
      };

      await stellaHostRunner
        .handleLocalChat(
          {
            ...payload,
            requestId,
          },
          {
            onRunStarted: (ev) => {
              if (ev.uiVisibility === "hidden") {
                return;
              }
              if (isInstallUpdateAgent) {
                getFileLogger()?.process("desktop-update.agent.run-started", {
                  requestId,
                  conversationId: payload.conversationId,
                  runId: ev.runId,
                  agentType: ev.agentType,
                });
              }
              terminalRunIds.delete(ev.runId);
              runOwners.set(ev.runId, senderWebContentsId);
              runToConversationId.set(ev.runId, payload.conversationId);
              runToRequestId.set(ev.runId, requestId);
              requestToRunId.set(requestId, ev.runId);
              activeRunByConversation.set(payload.conversationId, {
                runId: ev.runId,
                conversationId: payload.conversationId,
                requestId,
                userMessageId: ev.userMessageId,
                uiVisibility: ev.uiVisibility,
              });
              emitAgentEvent(
                {
                  type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
                  runId: ev.runId,
                  conversationId: payload.conversationId,
                  requestId,
                  ...(ev.userMessageId
                    ? { userMessageId: ev.userMessageId }
                    : {}),
                  ...(ev.uiVisibility ? { uiVisibility: ev.uiVisibility } : {}),
                  ...(ev.agentType ? { agentType: ev.agentType } : {}),
                },
                senderWebContentsId,
              );
            },
            onStream: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.STREAM,
                  conversationId: payload.conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onAssistantMessage: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
                  conversationId: payload.conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onStatus: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.STATUS,
                  conversationId: payload.conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onToolStart: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
                  conversationId: payload.conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onToolEnd: (ev) =>
              emitAgentEvent(
                {
                  ...ev,
                  type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
                  conversationId: payload.conversationId,
                  requestId,
                },
                senderWebContentsId,
              ),
            onRunFinished: (ev) => {
              if (isInstallUpdateAgent) {
                getFileLogger()?.process("desktop-update.agent.run-finished", {
                  requestId,
                  conversationId: payload.conversationId,
                  runId: ev.runId,
                  outcome: ev.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
                  agentType: ev.agentType,
                  reason: ev.reason,
                  error: ev.error,
                });
              }
              emitRunFinished({
                runId: ev.runId,
                outcome: ev.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
                agentType: ev.agentType,
                userMessageId: ev.userMessageId,
                finalText: ev.finalText,
                persisted: ev.persisted,
                selfModApplied: ev.selfModApplied,
                error: ev.error,
                reason: ev.reason,
              });
            },
            onAgentEvent: (ev) => {
              if (!ev.rootRunId) {
                console.warn(
                  "[chat] Dropping task event without rootRunId:",
                  ev.type,
                  ev.agentId,
                );
                return;
              }
              emitAgentEvent(
                {
                  type: ev.type,
                  runId: ev.rootRunId,
                  rootRunId: ev.rootRunId,
                  conversationId: payload.conversationId,
                  requestId,
                  userMessageId: ev.userMessageId,
                  agentId: ev.agentId,
                  agentType: ev.agentType,
                  description: ev.description,
                  parentAgentId: ev.parentAgentId,
                  result: ev.result,
                  error: ev.error,
                  statusText: ev.statusText,
                  groupKey: ev.groupKey,
                  groupLabel: ev.groupLabel,
                },
                senderWebContentsId,
              );
            },
            onAgentReasoning: (ev) => {
              if (!ev.agentId) {
                return;
              }
              const runId = ev.rootRunId ?? ev.runId;
              emitAgentEvent(
                {
                  type: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
                  runId,
                  rootRunId: runId,
                  conversationId: payload.conversationId,
                  requestId,
                  userMessageId: ev.userMessageId,
                  agentId: ev.agentId,
                  agentType: ev.agentType,
                  chunk: ev.chunk,
                },
                senderWebContentsId,
              );
            },
            onSelfModHmrState: (ev) =>
              emitSelfModHmrState(ev, senderWebContentsId),
          },
        )
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : "Stella runtime failed";
          const startedRunId = requestToRunId.get(requestId);
          if (startedRunId) {
            emitRunFinished({
              runId: startedRunId,
              outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
              error: message,
              reason: message,
            });
            return;
          }

          if (isInstallUpdateAgent) {
            getFileLogger()?.error("desktop-update.agent.start-failed", {
              requestId,
              conversationId: payload.conversationId,
              error,
            });
          }
          console.error(
            "[chat] Local chat failed before runtime run start:",
            message,
          );
          requestOwners.delete(requestId);
          releaseClientRequest();
          throw error;
        });

      return { requestId };
    },
  );

  ipcMain.handle(
    "agent:sendInput",
    async (
      event,
      payload: {
        conversationId: string;
        threadId: string;
        message: string;
        metadata?: Record<string, unknown>;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "agent:sendInput")) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
      await stellaHostRunner.waitUntilConnected(5_000);
      return await stellaHostRunner.sendAgentInput(payload);
    },
  );

  ipcMain.on("agent:cancelChat", (event, runId: string) => {
    if (!options.assertPrivilegedSender(event, "agent:cancelChat")) {
      return;
    }
    const stellaHostRunner = options.getStellaHostRunner();
    if (stellaHostRunner && typeof runId === "string") {
      stellaHostRunner.cancelLocalChat(runId);
    }
  });

  ipcMain.handle(
    "selfmod:apply",
    async (event, payload: { commitHash?: string }) => {
      if (!options.assertPrivilegedSender(event, "selfmod:apply")) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
      return await stellaHostRunner.applySelfModCommit({
        commitHash: payload.commitHash,
      });
    },
  );

  ipcMain.handle(
    "selfmod:revert",
    async (event, payload: { commitHash?: string; steps?: number }) => {
      if (!options.assertPrivilegedSender(event, "selfmod:revert")) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
      return await stellaHostRunner.revertSelfModCommit({
        commitHash: payload.commitHash,
        steps: payload.steps,
      });
    },
  );

  ipcMain.handle("selfmod:crashRecoveryStatus", async (event) => {
    if (!options.assertPrivilegedSender(event, "selfmod:crashRecoveryStatus")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHostRunner = options.getStellaHostRunner();
    if (!stellaHostRunner) {
      throw new Error("Stella runtime not available");
    }
    return await stellaHostRunner.getCrashRecoveryStatus();
  });

  ipcMain.handle("selfmod:discardUnfinished", async (event, payload) => {
    if (!options.assertPrivilegedSender(event, "selfmod:discardUnfinished")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHostRunner = options.getStellaHostRunner();
    if (!stellaHostRunner) {
      throw new Error("Stella runtime not available");
    }
    return await stellaHostRunner.discardUnfinishedSelfModChanges({
      conversationId:
        typeof payload?.conversationId === "string"
          ? payload.conversationId
          : undefined,
    });
  });

  ipcMain.handle("selfmod:lastCommit", async (event) => {
    if (!options.assertPrivilegedSender(event, "selfmod:lastCommit")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHostRunner = options.getStellaHostRunner();
    if (!stellaHostRunner) {
      throw new Error("Stella runtime not available");
    }
    return await stellaHostRunner.getLastSelfModCommit();
  });

  ipcMain.handle(
    "selfmod:recentCommits",
    async (event, payload: { limit?: number } | undefined) => {
      if (!options.assertPrivilegedSender(event, "selfmod:recentCommits")) {
        throw new Error("Blocked untrusted request.");
      }
      const limit = Number(payload?.limit ?? 8);
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
      return await stellaHostRunner.listRecentSelfModCommits(limit);
    },
  );

  // Dev-only: trigger/fix a Vite compile error for testing the error overlay
  const TEST_BROKEN_FILE = path.join(
    options.stellaAppDir,
    "src",
    "testing",
    "__vite_error_trigger.tsx",
  );

  ipcMain.handle("devtest:triggerViteError", async (event) => {
    if (!options.assertPrivilegedSender(event, "devtest:triggerViteError")) {
      throw new Error("Blocked untrusted request.");
    }
    await fs.mkdir(path.dirname(TEST_BROKEN_FILE), { recursive: true });
    await fs.writeFile(
      TEST_BROKEN_FILE,
      "const x: number = {\n// deliberately broken syntax\n",
      "utf-8",
    );
    return { ok: true };
  });

  ipcMain.handle("devtest:fixViteError", async (event) => {
    if (!options.assertPrivilegedSender(event, "devtest:fixViteError")) {
      throw new Error("Blocked untrusted request.");
    }
    try {
      await fs.unlink(TEST_BROKEN_FILE);
    } catch {
      // Ignore missing temp files during cleanup.
    }
    return { ok: true };
  });
};
