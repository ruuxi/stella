import { ConvexHttpClient } from "convex/browser";
import { createToolHost } from "./tools.js";
import { loadSkillsFromHome } from "./skills.js";
import { loadAgentsFromHome } from "./agents.js";
import path from "path";

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

  const callMutation = (name: string, args: Record<string, unknown>) => {
    if (!client) return Promise.resolve(null);
    return client.mutation(name as never, args as never);
  };

  const callQuery = (name: string, args: Record<string, unknown>) => {
    if (!client) return Promise.resolve(null);
    return client.query(name as never, args as never);
  };

  const syncManifests = async () => {
    if (!client) return;
    const now = Date.now();
    if (syncPromise) return syncPromise;
    if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;

    syncPromise = (async () => {
      try {
        await callMutation("agents.ensureBuiltins", {});

        const pluginPayload = await toolHost.loadPlugins();
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
      } catch {
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
    inFlight.add(request.requestId);

    try {
      const existing = await callQuery("events.getToolResult", {
        requestId: request.requestId,
        deviceId,
      });
      if (existing) {
        processed.add(request.requestId);
        return;
      }

      const toolName = request.payload?.toolName;
      const toolArgs = request.payload?.args ?? {};
      if (!toolName) {
        await appendToolResult(request, { error: "toolName missing on request." });
        processed.add(request.requestId);
        return;
      }

      const toolResult = await toolHost.executeTool(toolName, toolArgs, {
        conversationId: request.conversationId,
        deviceId,
        requestId: request.requestId,
      });

      await appendToolResult(request, toolResult);
      processed.add(request.requestId);
    } catch (error) {
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
  };

  const start = () => {
    if (pollTimer) return;
    void syncManifests();
    pollTimer = setInterval(() => {
      void pollOnce();
      void syncManifests();
    }, POLL_INTERVAL_MS);
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
