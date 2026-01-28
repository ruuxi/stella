import { ConvexHttpClient } from "convex/browser";
import { createToolHost } from "./tools.js";
import { loadSkillsFromHome } from "./skills.js";
import { loadAgentsFromHome } from "./agents.js";
import path from "path";

const log = (...args: unknown[]) => console.log("[runner]", ...args);
const logError = (...args: unknown[]) => console.error("[runner]", ...args);

type HostRunnerOptions = {
  deviceId: string;
  stellarHome: string;
};

type ToolRequestEvent = {
  _id: string;
  conversationId: string;
  type: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: {
    toolName?: string;
    args?: Record<string, unknown>;
    targetDeviceId?: string;
  };
};

type PaginatedResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string | null;
};

const POLL_INTERVAL_MS = 1500;

export const createLocalHostRunner = ({ deviceId, stellarHome }: HostRunnerOptions) => {
  const toolHost = createToolHost({ stellarHome });
  let client: ConvexHttpClient | null = null;
  let convexUrl: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const processed = new Set<string>();
  const inFlight = new Set<string>();
  let queue = Promise.resolve();
  let syncPromise: Promise<void> | null = null;
  let lastSyncAt = 0;

  const skillsPath = path.join(stellarHome, "skills");
  const agentsPath = path.join(stellarHome, "agents");
  const SYNC_MIN_INTERVAL_MS = 15_000;

  const toConvexName = (name: string) => {
    // Convex expects "module:function" identifiers, not dot-separated paths.
    const firstDot = name.indexOf(".");
    if (firstDot === -1) return name;
    return `${name.slice(0, firstDot)}:${name.slice(firstDot + 1)}`;
  };

  const callMutation = (name: string, args: Record<string, unknown>) => {
    if (!client) return Promise.resolve(null);
    const convexName = toConvexName(name);
    return client.mutation(convexName as never, args as never);
  };

  const callQuery = (name: string, args: Record<string, unknown>) => {
    if (!client) return Promise.resolve(null);
    const convexName = toConvexName(name);
    return client.query(convexName as never, args as never);
  };

  const syncManifests = async () => {
    if (!client) return;
    const now = Date.now();
    if (syncPromise) return syncPromise;
    if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;

    syncPromise = (async () => {
      try {
        log("Syncing manifests...");
        await callMutation("agents.ensureBuiltins", {});

        const pluginPayload = await toolHost.loadPlugins();
        log("Loaded plugins:", {
          pluginCount: pluginPayload.plugins.length,
          toolCount: pluginPayload.tools.length,
          skillCount: pluginPayload.skills.length,
          agentCount: pluginPayload.agents.length,
          toolNames: pluginPayload.tools.map((t) => t.name),
        });

        const skills = await loadSkillsFromHome(skillsPath, pluginPayload.skills);
        const agents = await loadAgentsFromHome(agentsPath, pluginPayload.agents);

        await callMutation("skills.upsertMany", {
          skills,
        });
        await callMutation("agents.upsertMany", {
          agents,
        });
        await callMutation("plugins.upsertMany", {
          plugins: pluginPayload.plugins,
          tools: pluginPayload.tools,
        });

        lastSyncAt = Date.now();
        log("Manifest sync complete");
      } catch (error) {
        logError("Manifest sync failed:", error);
        // Best-effort sync; ignore failures and retry later.
      } finally {
        syncPromise = null;
      }
    })();

    return syncPromise;
  };

  const setConvexUrl = (url: string) => {
    if (convexUrl === url && client) {
      return;
    }
    convexUrl = url;
    client = new ConvexHttpClient(url, { logger: false });
    void syncManifests();
  };

  const appendToolResult = async (
    request: ToolRequestEvent,
    result: { result?: unknown; error?: string },
  ) => {
    if (!client || !request.requestId) return;
    await callMutation("events.appendEvent", {
      conversationId: request.conversationId,
      type: "tool_result",
      deviceId,
      requestId: request.requestId,
      targetDeviceId: request.targetDeviceId,
      payload: {
        toolName: request.payload?.toolName,
        result: result.result,
        error: result.error,
        requestId: request.requestId,
        targetDeviceId: request.targetDeviceId,
      },
    });
  };

  const handleToolRequest = async (request: ToolRequestEvent) => {
    if (!client || request.type !== "tool_request" || !request.requestId) {
      return;
    }
    if (processed.has(request.requestId) || inFlight.has(request.requestId)) {
      return;
    }

    const toolName = request.payload?.toolName;
    log(`Received tool request: ${toolName}`, {
      requestId: request.requestId,
      conversationId: request.conversationId,
    });

    inFlight.add(request.requestId);

    try {
      const existing = await callQuery("events.getToolResult", {
        requestId: request.requestId,
        deviceId,
      });
      if (existing) {
        log(`Tool request ${request.requestId} already processed, skipping`);
        processed.add(request.requestId);
        return;
      }

      const toolArgs = request.payload?.args ?? {};
      if (!toolName) {
        logError("Tool request missing toolName:", request);
        await appendToolResult(request, { error: "toolName missing on request." });
        processed.add(request.requestId);
        return;
      }

      log(`Executing tool: ${toolName}`, {
        argsPreview: JSON.stringify(toolArgs).slice(0, 200),
      });

      const startTime = Date.now();
      const toolResult = await toolHost.executeTool(toolName, toolArgs, {
        conversationId: request.conversationId,
        deviceId,
        requestId: request.requestId,
      });
      const duration = Date.now() - startTime;

      log(`Tool ${toolName} completed in ${duration}ms`, {
        hasResult: "result" in toolResult,
        hasError: "error" in toolResult,
        errorPreview: toolResult.error?.slice(0, 300),
      });

      await appendToolResult(request, toolResult);
      processed.add(request.requestId);
    } catch (error) {
      logError(`Tool request ${toolName} failed with exception:`, error);
      await appendToolResult(request, {
        error: `Tool execution failed: ${(error as Error).message}`,
      });
      processed.add(request.requestId);
    } finally {
      inFlight.delete(request.requestId);
    }
  };

  const pollOnce = async () => {
    if (!client) return;
    try {
      const response = await callQuery("events.listToolRequestsForDevice", {
        deviceId,
        paginationOpts: { cursor: null, numItems: 20 },
      });

      if (!response || typeof response !== "object" || !("page" in response)) {
        return;
      }

      const result = response as PaginatedResult<ToolRequestEvent>;

      for (const request of result.page) {
        queue = queue.then(() => handleToolRequest(request)).catch(() => undefined);
      }
    } catch {
      // Swallow polling errors; they will be retried on the next interval.
    }
  };

  const start = () => {
    if (pollTimer) return;
    log("Starting local host runner", { deviceId, stellarHome });
    void syncManifests();
    pollTimer = setInterval(() => {
      void pollOnce();
      void syncManifests();
    }, POLL_INTERVAL_MS);
    log("Local host runner started, polling every", POLL_INTERVAL_MS, "ms");
  };

  const stop = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  return {
    deviceId,
    setConvexUrl,
    start,
    stop,
  };
};
