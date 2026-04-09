import {
  ipcMain,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { promises as fs } from "fs";
import path from "path";
import {
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
  type AgentStreamEventType,
} from "../../src/shared/contracts/agent-runtime.js";
import type { SelfModHmrState } from "../../src/shared/contracts/boundary.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { HmrTransitionController } from "../self-mod/hmr-morph.js";
import { createMonotonicSeqGenerator } from "./monotonic-seq.js";

type AgentHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  getAppSessionStartedAt: () => number;
  isHostAuthAuthenticated: () => boolean;
  frontendRoot: string;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  hmrTransitionController?: HmrTransitionController | null;
  getBroadcastToMobile?: () => ((channel: string, data: unknown) => void) | null;
};

type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  chunk?: string;
  statusState?: "running" | "compacting";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
  taskId?: string;
  agentType?: AgentIdLike;
  description?: string;
  parentTaskId?: string;
  result?: string;
  statusText?: string;
};

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

export const registerAgentHandlers = (options: AgentHandlersOptions) => {
  const agentRunOwners = new Map<string, number>();
  const nextTaskEventSeq = createMonotonicSeqGenerator();
  const agentEventBuffers = new Map<
    string,
    {
      events: AgentEventPayload[];
      updatedAt: number;
    }
  >();

  const pruneAgentEventBuffers = () => {
    const now = Date.now();
    for (const [runId, buffer] of agentEventBuffers.entries()) {
      if (agentRunOwners.has(runId)) continue;
      if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
        agentEventBuffers.delete(runId);
      }
    }
  };

  const bufferAgentEvent = (runId: string, event: AgentEventPayload) => {
    const existing = agentEventBuffers.get(runId);
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

    agentEventBuffers.set(runId, {
      events: [event],
      updatedAt: Date.now(),
    });
  };

  const emitAgentEvent = (
    runId: string,
    event: AgentEventPayload,
    targetWebContentsId?: number,
  ) => {
    bufferAgentEvent(runId, event);
    pruneAgentEventBuffers();
    options.getBroadcastToMobile?.()?.("agent:event", event);
    const receiverId = targetWebContentsId ?? agentRunOwners.get(runId);
    if (receiverId == null) {
      return;
    }
    const receiver = webContents.fromId(receiverId);
    if (receiver && !receiver.isDestroyed()) {
      receiver.send("agent:event", event);
    }
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
    async (_event, payload: { runId: string; lastSeq: number }) => {
      pruneAgentEventBuffers();
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const lastSeq = Number.isFinite(payload.lastSeq) ? payload.lastSeq : 0;
      if (!runId) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const buffer = agentEventBuffers.get(runId);
      if (!buffer) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const oldestSeq = buffer.events[0]?.seq ?? null;
      const exhausted = oldestSeq !== null && lastSeq < oldestSeq - 1;
      return {
        events: buffer.events.filter((event) => event.seq > lastSeq),
        exhausted,
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
        chatContext?: import("../../runtime/contracts/index.js").ChatContext | null;
        deviceId?: string;
        platform?: string;
        timezone?: string;
        mode?: string;
        messageMetadata?: Record<string, unknown>;
        attachments?: Array<{
          url: string;
          mimeType?: string;
        }>;
        agentType?: string;
        storageMode?: "cloud" | "local";
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "agent:startChat")) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
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

      console.log(
        `[stella:trace] IPC agent:startChat | convId=${payload.conversationId} | prompt=${redactSensitiveLogText(payload.userPrompt.slice(0, 200))}`,
      );
      const senderWebContentsId = event.sender.id;
      const result = await stellaHostRunner.handleLocalChat(payload, {
        onStream: (ev) =>
          emitAgentEvent(
            ev.runId,
            { ...ev, type: AGENT_STREAM_EVENT_TYPES.STREAM },
            senderWebContentsId,
          ),
        onStatus: (ev) =>
          emitAgentEvent(
            ev.runId,
            { ...ev, type: AGENT_STREAM_EVENT_TYPES.STATUS },
            senderWebContentsId,
          ),
        onToolStart: (ev) =>
          emitAgentEvent(
            ev.runId,
            { ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_START },
            senderWebContentsId,
          ),
        onToolEnd: (ev) =>
          emitAgentEvent(
            ev.runId,
            { ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_END },
            senderWebContentsId,
          ),
        onError: (ev) =>
          emitAgentEvent(
            ev.runId,
            { ...ev, type: AGENT_STREAM_EVENT_TYPES.ERROR },
            senderWebContentsId,
          ),
        onTaskEvent: (ev) => {
          const runId =
            ev.rootRunId ??
            [...agentRunOwners.keys()].find(
              (id) => agentRunOwners.get(id) === senderWebContentsId,
            ) ??
            "unknown";
          emitAgentEvent(
            runId,
            {
              type: ev.type,
              runId,
              seq: nextTaskEventSeq(),
              taskId: ev.taskId,
              agentType: ev.agentType,
              description: ev.description,
              parentTaskId: ev.parentTaskId,
              result: ev.result,
              error: ev.error,
              statusText: ev.statusText,
            },
            senderWebContentsId,
          );
        },
        onEnd: (ev) => {
          emitAgentEvent(
            ev.runId,
            { ...ev, type: AGENT_STREAM_EVENT_TYPES.END },
            senderWebContentsId,
          );
          setTimeout(() => {
            agentRunOwners.delete(ev.runId);
            pruneAgentEventBuffers();
          }, 60_000);
        },
        onSelfModHmrState: (ev) => emitSelfModHmrState(ev, senderWebContentsId),
        onHmrResume: options.hmrTransitionController
          ? ({ runId, resumeHmr, reportState, requiresFullReload }) =>
              options.hmrTransitionController!.runTransition({
                runId,
                resumeHmr,
                reportState,
                requiresFullReload,
              })
          : undefined,
      });

      agentRunOwners.set(result.runId, senderWebContentsId);
      return result;
    },
  );

  ipcMain.on("agent:cancelChat", (event, runId: string) => {
    if (!options.assertPrivilegedSender(event, "agent:cancelChat")) {
      return;
    }
    const stellaHostRunner = options.getStellaHostRunner();
    if (stellaHostRunner && typeof runId === "string") {
      stellaHostRunner.cancelLocalChat(runId);
      agentRunOwners.delete(runId);
    }
  });

  ipcMain.handle(
    "selfmod:revert",
    async (event, payload: { featureId?: string; steps?: number }) => {
      if (!options.assertPrivilegedSender(event, "selfmod:revert")) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
      return await stellaHostRunner.revertSelfModFeature({
        featureId: payload.featureId,
        steps: payload.steps,
      });
    },
  );

  ipcMain.handle("selfmod:lastFeature", async (event) => {
    if (!options.assertPrivilegedSender(event, "selfmod:lastFeature")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHostRunner = options.getStellaHostRunner();
    if (!stellaHostRunner) {
      throw new Error("Stella runtime not available");
    }
    return await stellaHostRunner.getLastSelfModFeature();
  });

  ipcMain.handle(
    "selfmod:recentFeatures",
    async (event, payload: { limit?: number } | undefined) => {
      if (!options.assertPrivilegedSender(event, "selfmod:recentFeatures")) {
        throw new Error("Blocked untrusted request.");
      }
      const limit = Number(payload?.limit ?? 8);
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not available");
      }
      return await stellaHostRunner.listRecentSelfModFeatures(limit);
    },
  );

  // Dev-only: trigger/fix a Vite compile error for testing the error overlay
  const TEST_BROKEN_FILE = path.join(
    options.frontendRoot,
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
