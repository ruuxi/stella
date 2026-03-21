import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "../../stella-runtime-protocol/src/rpc-peer.js";
import { attachJsonRpcPeerToStreams } from "../../stella-runtime-protocol/src/jsonl.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type AgentHealth,
  type RuntimeActiveRun,
  type RuntimeAgentEventPayload,
  type RuntimeCommandRunParams,
  type RuntimeConfigureParams,
  type RuntimeHealthSnapshot,
  type RuntimeInitializeParams,
  type RunResumeEventsResult,
} from "../../stella-runtime-protocol/src/index.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../../electron/system/private-fs.js";

type WorkerConnection = {
  process: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  pid: number;
};

type DaemonState = {
  init: RuntimeInitializeParams | null;
  worker: WorkerConnection | null;
  workerGeneration: number;
  agentEventBuffers: Map<
    string,
    {
      events: RuntimeAgentEventPayload[];
      updatedAt: number;
    }
  >;
  server: http.Server | null;
  tokenPath: string | null;
  token: string | null;
  config: Required<Pick<RuntimeConfigureParams, "convexUrl" | "convexSiteUrl" | "authToken" | "cloudSyncEnabled">>;
  suppressWorkerRespawn: boolean;
};

const AGENT_EVENT_BUFFER_LIMIT = 1_000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1_000;
const TOKEN_HEADER = "x-stella-ui-token";

const getCommandSocketPath = (statePath: string): string => {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\stella-ui";
  }
  return path.join(statePath, "stella-ui.sock");
};

const getCommandTokenPath = (statePath: string): string =>
  path.join(statePath, "stella-ui.token");

const resolveWorkerEntryPath = () =>
  fileURLToPath(new URL("../../stella-runtime-worker/src/entry.js", import.meta.url));

const pruneAgentEventBuffers = (state: DaemonState) => {
  const now = Date.now();
  for (const [runId, buffer] of state.agentEventBuffers.entries()) {
    if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
      state.agentEventBuffers.delete(runId);
    }
  }
};

const bufferAgentEvent = (state: DaemonState, event: RuntimeAgentEventPayload) => {
  const existing = state.agentEventBuffers.get(event.runId);
  if (existing) {
    existing.events.push(event);
    if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
      existing.events.splice(0, existing.events.length - AGENT_EVENT_BUFFER_LIMIT);
    }
    existing.updatedAt = Date.now();
    return;
  }
  state.agentEventBuffers.set(event.runId, {
    events: [event],
    updatedAt: Date.now(),
  });
};

const stopWorker = async (connection: WorkerConnection | null) => {
  if (!connection) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    connection.process.once("exit", finish);
    connection.process.kill("SIGTERM");
    setTimeout(() => {
      if (settled) return;
      connection.process.kill("SIGKILL");
      finish();
    }, 1_500).unref();
  });
};

const startCliServer = async (
  state: DaemonState,
  runCommand: (params: RuntimeCommandRunParams) => Promise<{
    exitCode: number;
    stdout: string;
    stderr?: string;
  }>,
) => {
  if (!state.init) {
    return;
  }
  const statePath = path.join(state.init.stellaHomePath, "state");
  if (state.server) {
    return;
  }
  const token = crypto.randomUUID();
  const tokenPath = getCommandTokenPath(statePath);
  state.token = token;
  state.tokenPath = tokenPath;
  writePrivateFileSync(tokenPath, token);

  const server = http.createServer(async (req, res) => {
    if (req.headers[TOKEN_HEADER] !== token) {
      res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("Unauthorized");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("Method Not Allowed");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: RuntimeCommandRunParams;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as RuntimeCommandRunParams;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("Invalid JSON");
      return;
    }
    try {
      const result = await runCommand(body);
      res.writeHead(result.exitCode === 0 ? 200 : 500, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end(result.exitCode === 0 ? result.stdout : result.stderr ?? result.stdout);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  const socketPath = getCommandSocketPath(statePath);
  if (process.platform !== "win32") {
    ensurePrivateDirSync(path.dirname(socketPath));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  state.server = server;
};

const stopCliServer = (state: DaemonState) => {
  state.server?.close();
  state.server = null;
  if (state.tokenPath) {
    try {
      fs.unlinkSync(state.tokenPath);
    } catch {
      // Ignore cleanup failures.
    }
  }
  state.tokenPath = null;
  state.token = null;
};

export const createRuntimeDaemonServer = (peer: JsonRpcPeer) => {
  const state: DaemonState = {
    init: null,
    worker: null,
    workerGeneration: 0,
    agentEventBuffers: new Map(),
    server: null,
    tokenPath: null,
    token: null,
    config: {
      convexUrl: null,
      convexSiteUrl: null,
      authToken: null,
      cloudSyncEnabled: false,
    },
    suppressWorkerRespawn: false,
  };

  const forwardToWorker = async <TResult = unknown>(
    method: string,
    params?: unknown,
  ): Promise<TResult> => {
    if (!state.worker) {
      throw createRuntimeUnavailableError("Runtime worker is not available.");
    }
    return await state.worker.peer.request<TResult>(method, params);
  };

  const spawnWorker = async () => {
    if (!state.init) {
      throw createRuntimeUnavailableError("Runtime daemon has not been initialized.");
    }
    state.suppressWorkerRespawn = true;
    const previousWorker = state.worker;
    await stopWorker(previousWorker);
    if (state.worker === previousWorker) {
      state.worker = null;
    }

    const child = spawn(process.execPath, [resolveWorkerEntryPath()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    const { peer: workerPeer } = attachJsonRpcPeerToStreams({
      input: child.stdout,
      output: child.stdin,
      onError: (error) => {
        console.error("[stella-runtime-daemon] worker RPC error:", error);
      },
    });

    const hostForwardMethods = [
      METHOD_NAMES.HOST_UI_SNAPSHOT,
      METHOD_NAMES.HOST_UI_ACT,
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
      METHOD_NAMES.HOST_DEVICE_HEARTBEAT_SIGN,
      METHOD_NAMES.HOST_CREDENTIALS_REQUEST,
      METHOD_NAMES.HOST_DISPLAY_UPDATE,
      METHOD_NAMES.HOST_NOTIFICATION_SHOW,
      METHOD_NAMES.HOST_SYSTEM_OPEN_EXTERNAL,
      METHOD_NAMES.HOST_WINDOW_SHOW,
      METHOD_NAMES.HOST_WINDOW_FOCUS,
      METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
    ] as const;

    for (const method of hostForwardMethods) {
      workerPeer.registerRequestHandler(method, async (params) => {
        return await peer.request(method, params);
      });
    }

    workerPeer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_EVENT, (params) => {
      const event = params as RuntimeAgentEventPayload;
      bufferAgentEvent(state, event);
      pruneAgentEventBuffers(state);
      peer.notify(NOTIFICATION_NAMES.RUN_EVENT, event);
    });
    workerPeer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_SELF_MOD_HMR_STATE, (params) => {
      peer.notify(NOTIFICATION_NAMES.RUN_SELF_MOD_HMR_STATE, params);
    });
    workerPeer.registerNotificationHandler(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, () => {
      peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
    });
    workerPeer.registerNotificationHandler(NOTIFICATION_NAMES.SCHEDULE_UPDATED, () => {
      peer.notify(NOTIFICATION_NAMES.SCHEDULE_UPDATED, null);
    });

    const connection = {
      process: child,
      peer: workerPeer,
      pid: child.pid ?? 0,
    };
    state.worker = connection;

    child.once("exit", () => {
      if (state.worker?.process === child) {
        state.worker = null;
      }
      if (!state.suppressWorkerRespawn && state.init) {
        setTimeout(() => {
          if (state.init && !state.worker) {
            void spawnWorker().catch((error) => {
              console.error("[stella-runtime-daemon] Failed to respawn worker:", error);
            });
          }
        }, 250).unref();
      }
    });

    try {
      const config = await forwardToWorker<{
        pid: number;
        deviceId: string | null;
        commandSourcePaths: string[];
      }>(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE, {
        stellaHomePath: state.init.stellaHomePath,
        stellaWorkspacePath: state.init.stellaWorkspacePath,
        frontendRoot: state.init.frontendRoot,
        convexUrl: state.config.convexUrl,
        convexSiteUrl: state.config.convexSiteUrl,
        authToken: state.config.authToken,
        cloudSyncEnabled: state.config.cloudSyncEnabled,
      });

      state.workerGeneration += 1;
      peer.notify(NOTIFICATION_NAMES.CAPABILITY_CHANGED, {
        workerGeneration: state.workerGeneration,
        sourcePaths: config.commandSourcePaths,
      });
    } catch (error) {
      if (state.worker?.process === child) {
        state.worker = null;
      }
      await stopWorker(connection);
      throw error;
    } finally {
      state.suppressWorkerRespawn = false;
    }
  };

  peer.registerRequestHandler(METHOD_NAMES.INITIALIZE, async (params) => {
    const init = params as RuntimeInitializeParams;
    if (init.protocolVersion !== STELLA_RUNTIME_PROTOCOL_VERSION) {
      throw new Error(
        `Protocol mismatch. Expected ${STELLA_RUNTIME_PROTOCOL_VERSION}, got ${init.protocolVersion}.`,
      );
    }
    state.init = init;
    await spawnWorker();
    await startCliServer(state, async (params) =>
      await forwardToWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_COMMAND, params),
    );
    return {
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
      daemonPid: process.pid,
    };
  });

  peer.registerRequestHandler(METHOD_NAMES.INITIALIZED, async () => {
    const health = await forwardToWorker<{
      health: AgentHealth;
      activeRun: RuntimeActiveRun | null;
      activeTaskCount: number;
      pid: number;
      deviceId: string | null;
    }>(METHOD_NAMES.INTERNAL_WORKER_HEALTH);
    peer.notify(NOTIFICATION_NAMES.RUNTIME_READY, {
      ready: Boolean(health.health.ready),
      daemonPid: process.pid,
      workerPid: health.pid,
      workerGeneration: state.workerGeneration,
      deviceId: health.deviceId,
      activeRunId: health.activeRun?.runId ?? null,
      activeTaskCount: health.activeTaskCount,
    } satisfies RuntimeHealthSnapshot);
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_CONFIGURE, async (params) => {
    state.config = {
      ...state.config,
      ...(params as RuntimeConfigureParams),
    };
    await forwardToWorker(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, params);
    const health = await forwardToWorker<{
      health: AgentHealth;
      activeRun: RuntimeActiveRun | null;
      activeTaskCount: number;
      pid: number;
      deviceId: string | null;
    }>(METHOD_NAMES.INTERNAL_WORKER_HEALTH);
    peer.notify(NOTIFICATION_NAMES.RUNTIME_READY, {
      ready: Boolean(health.health.ready),
      daemonPid: process.pid,
      workerPid: health.pid,
      workerGeneration: state.workerGeneration,
      deviceId: health.deviceId,
      activeRunId: health.activeRun?.runId ?? null,
      activeTaskCount: health.activeTaskCount,
    } satisfies RuntimeHealthSnapshot);
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_HEALTH, async () => {
    const health = await forwardToWorker<{
      health: AgentHealth;
      activeRun: RuntimeActiveRun | null;
      activeTaskCount: number;
      pid: number;
      deviceId: string | null;
    }>(METHOD_NAMES.INTERNAL_WORKER_HEALTH);
    return {
      ready: Boolean(health.health.ready),
      daemonPid: process.pid,
      workerPid: health.pid,
      workerGeneration: state.workerGeneration,
      deviceId: health.deviceId,
      activeRunId: health.activeRun?.runId ?? null,
      activeTaskCount: health.activeTaskCount,
    } satisfies RuntimeHealthSnapshot;
  });

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_RELOAD_CAPABILITIES, async () => {
    peer.notify(NOTIFICATION_NAMES.RUNTIME_RELOADING, { reason: "capabilities" });
    const result = await forwardToWorker<{ ok: true; sourcePaths: string[] }>(
      METHOD_NAMES.INTERNAL_WORKER_RELOAD_CAPABILITIES,
    );
    peer.notify(NOTIFICATION_NAMES.CAPABILITY_CHANGED, {
      workerGeneration: state.workerGeneration,
      sourcePaths: result.sourcePaths,
    });
    return result;
  });

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_RESTART_WORKER, async () => {
    peer.notify(NOTIFICATION_NAMES.RUNTIME_RELOADING, { reason: "worker" });
    await spawnWorker();
    const health = await forwardToWorker<{
      health: AgentHealth;
      activeRun: RuntimeActiveRun | null;
      activeTaskCount: number;
      pid: number;
      deviceId: string | null;
    }>(METHOD_NAMES.INTERNAL_WORKER_HEALTH);
    peer.notify(NOTIFICATION_NAMES.RUNTIME_READY, {
      ready: Boolean(health.health.ready),
      daemonPid: process.pid,
      workerPid: health.pid,
      workerGeneration: state.workerGeneration,
      deviceId: health.deviceId,
      activeRunId: health.activeRun?.runId ?? null,
      activeTaskCount: health.activeTaskCount,
    } satisfies RuntimeHealthSnapshot);
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.RUN_HEALTH_CHECK, async () => {
    const health = await forwardToWorker<{
      health: unknown;
    }>(METHOD_NAMES.INTERNAL_WORKER_HEALTH);
    return health.health;
  });

  peer.registerRequestHandler(METHOD_NAMES.RUN_GET_ACTIVE, async () => {
    return await forwardToWorker(METHOD_NAMES.INTERNAL_WORKER_GET_ACTIVE);
  });

  peer.registerRequestHandler(METHOD_NAMES.RUN_START_CHAT, async (params) => {
    return await forwardToWorker(METHOD_NAMES.INTERNAL_WORKER_START_CHAT, params);
  });

  peer.registerRequestHandler(METHOD_NAMES.RUN_CANCEL, async (params) => {
    return await forwardToWorker(METHOD_NAMES.INTERNAL_WORKER_CANCEL, params);
  });

  peer.registerRequestHandler(METHOD_NAMES.RUN_RESUME_EVENTS, async (params) => {
    pruneAgentEventBuffers(state);
    const payload = params as { runId: string; lastSeq: number };
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    const lastSeq = Number.isFinite(payload.lastSeq) ? payload.lastSeq : 0;
    if (!runId) {
      return { events: [], exhausted: true } satisfies RunResumeEventsResult;
    }
    const buffer = state.agentEventBuffers.get(runId);
    if (!buffer) {
      return { events: [], exhausted: true } satisfies RunResumeEventsResult;
    }
    const oldestSeq = buffer.events[0]?.seq ?? null;
    const exhausted = oldestSeq !== null && lastSeq < oldestSeq - 1;
    return {
      events: buffer.events.filter((event) => event.seq > lastSeq),
      exhausted,
    } satisfies RunResumeEventsResult;
  });

  const workerProxyMethods = [
    METHOD_NAMES.RUN_AUTOMATION,
    METHOD_NAMES.TASK_RUN_BLOCKING,
    METHOD_NAMES.TASK_CREATE_BACKGROUND,
    METHOD_NAMES.TASK_GET_SNAPSHOT,
    METHOD_NAMES.SEARCH_WEB,
    METHOD_NAMES.THREAD_APPEND_MESSAGE,
    METHOD_NAMES.LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    METHOD_NAMES.LOCAL_CHAT_LIST_EVENTS,
    METHOD_NAMES.LOCAL_CHAT_GET_EVENT_COUNT,
    METHOD_NAMES.LOCAL_CHAT_APPEND_EVENT,
    METHOD_NAMES.LOCAL_CHAT_LIST_SYNC_MESSAGES,
    METHOD_NAMES.LOCAL_CHAT_GET_SYNC_CHECKPOINT,
    METHOD_NAMES.LOCAL_CHAT_SET_SYNC_CHECKPOINT,
    METHOD_NAMES.STORE_MODS_LIST_FEATURES,
    METHOD_NAMES.STORE_MODS_LIST_BATCHES,
    METHOD_NAMES.STORE_MODS_CREATE_RELEASE_DRAFT,
    METHOD_NAMES.STORE_MODS_LIST_INSTALLED,
    METHOD_NAMES.STORE_LIST_PACKAGES,
    METHOD_NAMES.STORE_GET_PACKAGE,
    METHOD_NAMES.STORE_LIST_RELEASES,
    METHOD_NAMES.STORE_GET_RELEASE,
    METHOD_NAMES.STORE_CREATE_FIRST_RELEASE,
    METHOD_NAMES.STORE_CREATE_RELEASE_UPDATE,
    METHOD_NAMES.STORE_PUBLISH_RELEASE,
    METHOD_NAMES.STORE_INSTALL_RELEASE,
    METHOD_NAMES.STORE_UNINSTALL_MOD,
    METHOD_NAMES.SCHEDULE_LIST_CRON_JOBS,
    METHOD_NAMES.SCHEDULE_LIST_HEARTBEATS,
    METHOD_NAMES.SCHEDULE_LIST_EVENTS,
    METHOD_NAMES.SCHEDULE_GET_EVENT_COUNT,
    METHOD_NAMES.SOCIAL_SESSIONS_GET_STATUS,
    METHOD_NAMES.COMMAND_LIST,
    METHOD_NAMES.COMMAND_RUN,
    METHOD_NAMES.SHELL_KILL_ALL,
    METHOD_NAMES.SHELL_KILL_BY_PORT,
  ] as const;

  const workerMethodMap: Record<(typeof workerProxyMethods)[number], string> = {
    [METHOD_NAMES.RUN_AUTOMATION]: METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
    [METHOD_NAMES.TASK_RUN_BLOCKING]: METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_TASK,
    [METHOD_NAMES.TASK_CREATE_BACKGROUND]: METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_TASK,
    [METHOD_NAMES.TASK_GET_SNAPSHOT]: METHOD_NAMES.INTERNAL_WORKER_GET_TASK_SNAPSHOT,
    [METHOD_NAMES.SEARCH_WEB]: METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH,
    [METHOD_NAMES.THREAD_APPEND_MESSAGE]: METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE,
    [METHOD_NAMES.LOCAL_CHAT_GET_OR_CREATE_DEFAULT]:
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    [METHOD_NAMES.LOCAL_CHAT_LIST_EVENTS]: METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS,
    [METHOD_NAMES.LOCAL_CHAT_GET_EVENT_COUNT]:
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT,
    [METHOD_NAMES.LOCAL_CHAT_APPEND_EVENT]:
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT,
    [METHOD_NAMES.LOCAL_CHAT_LIST_SYNC_MESSAGES]:
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES,
    [METHOD_NAMES.LOCAL_CHAT_GET_SYNC_CHECKPOINT]:
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT,
    [METHOD_NAMES.LOCAL_CHAT_SET_SYNC_CHECKPOINT]:
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT,
    [METHOD_NAMES.STORE_MODS_LIST_FEATURES]:
      METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_FEATURES,
    [METHOD_NAMES.STORE_MODS_LIST_BATCHES]:
      METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_BATCHES,
    [METHOD_NAMES.STORE_MODS_CREATE_RELEASE_DRAFT]:
      METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_CREATE_RELEASE_DRAFT,
    [METHOD_NAMES.STORE_MODS_LIST_INSTALLED]:
      METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED,
    [METHOD_NAMES.STORE_LIST_PACKAGES]: METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES,
    [METHOD_NAMES.STORE_GET_PACKAGE]: METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE,
    [METHOD_NAMES.STORE_LIST_RELEASES]: METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES,
    [METHOD_NAMES.STORE_GET_RELEASE]: METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE,
    [METHOD_NAMES.STORE_CREATE_FIRST_RELEASE]:
      METHOD_NAMES.INTERNAL_WORKER_CREATE_FIRST_STORE_RELEASE,
    [METHOD_NAMES.STORE_CREATE_RELEASE_UPDATE]:
      METHOD_NAMES.INTERNAL_WORKER_CREATE_STORE_RELEASE_UPDATE,
    [METHOD_NAMES.STORE_PUBLISH_RELEASE]:
      METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_RELEASE,
    [METHOD_NAMES.STORE_INSTALL_RELEASE]:
      METHOD_NAMES.INTERNAL_WORKER_INSTALL_STORE_RELEASE,
    [METHOD_NAMES.STORE_UNINSTALL_MOD]:
      METHOD_NAMES.INTERNAL_WORKER_UNINSTALL_STORE_MOD,
    [METHOD_NAMES.SCHEDULE_LIST_CRON_JOBS]:
      METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_LIST_CRON_JOBS,
    [METHOD_NAMES.SCHEDULE_LIST_HEARTBEATS]:
      METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_LIST_HEARTBEATS,
    [METHOD_NAMES.SCHEDULE_LIST_EVENTS]:
      METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_LIST_EVENTS,
    [METHOD_NAMES.SCHEDULE_GET_EVENT_COUNT]:
      METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_GET_EVENT_COUNT,
    [METHOD_NAMES.SOCIAL_SESSIONS_GET_STATUS]:
      METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS,
    [METHOD_NAMES.COMMAND_LIST]: METHOD_NAMES.INTERNAL_WORKER_LIST_COMMANDS,
    [METHOD_NAMES.COMMAND_RUN]: METHOD_NAMES.INTERNAL_WORKER_RUN_COMMAND,
    [METHOD_NAMES.SHELL_KILL_ALL]: METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS,
    [METHOD_NAMES.SHELL_KILL_BY_PORT]: METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT,
  };

  for (const method of workerProxyMethods) {
    peer.registerRequestHandler(method, async (params) => {
      return await forwardToWorker(workerMethodMap[method], params);
    });
  }

  process.once("exit", () => {
    state.suppressWorkerRespawn = true;
    stopCliServer(state);
    void stopWorker(state.worker);
  });
};
