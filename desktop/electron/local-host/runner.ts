import { ConvexClient } from "convex/browser";
import { createToolHost } from "./tools.js";
import { loadSkillsFromHome } from "./skills.js";
import { loadAgentsFromHome } from "./agents.js";
import path from "path";
import fs from "fs";

const log = (...args: unknown[]) => console.log("[runner]", ...args);
const logError = (...args: unknown[]) => console.error("[runner]", ...args);

type HostRunnerOptions = {
  deviceId: string;
  stellarHome: string;
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
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
    agentType?: string;
  };
};

type PaginatedResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string | null;
};

const SYNC_DEBOUNCE_MS = 500;

export const createLocalHostRunner = ({ deviceId, stellarHome, requestCredential }: HostRunnerOptions) => {
  const ownerId = "local";
  const toolHost = createToolHost({
    stellarHome,
    requestCredential,
    resolveSecret: async ({ provider, secretId }) => {
      if (!client) return null;
      if (secretId) {
        return (await callQuery("secrets.getSecretValueById", {
          ownerId,
          secretId,
        })) as
          | {
              secretId: string;
              provider: string;
              label: string;
              plaintext: string;
            }
          | null;
      }
      return (await callQuery("secrets.getSecretValueForProvider", {
        ownerId,
        provider,
      })) as
        | {
            secretId: string;
            provider: string;
            label: string;
            plaintext: string;
          }
        | null;
    },
  });
  let client: ConvexClient | null = null;
  let convexUrl: string | null = null;
  let authToken: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let isRunning = false;
  const processed = new Set<string>();
  const inFlight = new Set<string>();
  let queue = Promise.resolve();
  let syncPromise: Promise<void> | null = null;
  let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];

  const skillsPath = path.join(stellarHome, "skills");
  const agentsPath = path.join(stellarHome, "agents");
  const pluginsPath = path.join(stellarHome, "plugins");

  const toConvexName = (name: string) => {
    // Convex expects "module:function" identifiers, not dot-separated paths.
    const firstDot = name.indexOf(".");
    if (firstDot === -1) return name;
    return `${name.slice(0, firstDot)}:${name.slice(firstDot + 1)}`;
  };

  const callMutation = (name: string, args: Record<string, unknown>) => {
    if (!client || !authToken) return Promise.resolve(null);
    const convexName = toConvexName(name);
    return client.mutation(convexName as never, args as never);
  };

  const callQuery = (name: string, args: Record<string, unknown>) => {
    if (!client || !authToken) return Promise.resolve(null);
    const convexName = toConvexName(name);
    return client.query(convexName as never, args as never);
  };

  const syncManifests = async () => {
    if (!client) return;
    if (syncPromise) return syncPromise;

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

        toolHost.setSkills(skills);

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

  const scheduleSyncManifests = () => {
    // Debounce file change events to avoid syncing too frequently
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
    }
    syncDebounceTimer = setTimeout(() => {
      syncDebounceTimer = null;
      void syncManifests();
    }, SYNC_DEBOUNCE_MS);
  };

  const startWatchers = () => {
    const watchDirs = [skillsPath, agentsPath, pluginsPath];

    for (const dir of watchDirs) {
      // Ensure directory exists before watching
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          logError(`Failed to create directory: ${dir}`);
          continue;
        }
      }

      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          log(`File ${eventType}: ${filename} in ${path.basename(dir)}`);
          scheduleSyncManifests();
        });

        watcher.on("error", (error) => {
          logError(`Watcher error for ${dir}:`, error);
        });

        watchers.push(watcher);
        log(`Watching for changes: ${dir}`);
      } catch (error) {
        logError(`Failed to watch directory ${dir}:`, error);
      }
    }
  };

  const stopWatchers = () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.length = 0;
  };

  const stopSubscription = () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
      log("Tool request subscription stopped");
    }
  };

  const startSubscription = () => {
    // Only start subscription if we have client, auth, and not already subscribed
    if (!client || !authToken || unsubscribe) return;

    // Use current timestamp to filter out historical requests
    // Only requests created AFTER this moment will be received
    const since = Date.now();
    log("Starting tool request subscription for device:", deviceId, { since });

    // Use onUpdate for real-time subscription to tool requests
    // The subscription will automatically receive updates when new tool requests are created
    unsubscribe = client.onUpdate(
      "events:listToolRequestsForDevice" as never,
      { deviceId, paginationOpts: { cursor: null, numItems: 20 }, since } as never,
      (response: unknown) => {
        if (!response || typeof response !== "object" || !("page" in response)) {
          return;
        }
        const result = response as PaginatedResult<ToolRequestEvent>;
        for (const request of result.page) {
          queue = queue.then(() => handleToolRequest(request)).catch(() => undefined);
        }
      },
    );

    log("Tool request subscription active - receiving only new requests");
  };

  const setConvexUrl = (url: string) => {
    if (convexUrl === url && client) {
      return;
    }
    // Stop existing subscription before changing client
    stopSubscription();
    convexUrl = url;
    // Close existing client if any
    if (client) {
      client.close();
    }
    client = new ConvexClient(url);
    if (authToken) {
      client.setAuth(() => Promise.resolve(authToken));
    }
    void syncManifests();
    // Restart subscription with new client if runner is running (and auth is set)
    if (isRunning) {
      startSubscription();
    }
  };

  const setAuthToken = (token: string | null) => {
    // Stop subscription before changing auth
    stopSubscription();
    authToken = token;
    if (!client) {
      return;
    }
    if (authToken) {
      client.setAuth(() => Promise.resolve(authToken));
      // Start subscription if runner is running and we now have auth
      if (isRunning) {
        startSubscription();
      }
    } else {
      // Clear auth by setting it to return null
      client.setAuth(() => Promise.resolve(null));
    }
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
        agentType: request.payload?.agentType,
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

  const start = () => {
    if (isRunning) return;
    isRunning = true;
    log("Starting local host runner", { deviceId, stellarHome });

    // Initial sync on startup
    void syncManifests();

    // Start file watchers for manifest changes
    startWatchers();

    // Start real-time subscription for tool requests (only if auth is ready)
    startSubscription();
  };

  const stop = () => {
    isRunning = false;
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }
    stopWatchers();
    stopSubscription();
    if (client) {
      client.close();
      client = null;
    }
  };

  // Expose tool execution for external callers
  const executeTool = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: { conversationId: string; deviceId: string; requestId: string; agentType?: string }
  ) => {
    return toolHost.executeTool(toolName, toolArgs, context);
  };

  return {
    deviceId,
    setConvexUrl,
    setAuthToken,
    start,
    stop,
    executeTool,
    getConvexUrl: () => convexUrl,
    getAuthToken: () => authToken,
  };
};
