import { ConvexClient } from "convex/browser";
import { createToolHost } from "./tools.js";
import { loadSkillsFromHome } from "./skills.js";
import { loadAgentsFromHome } from "./agents.js";
import { syncExternalSkills, syncBundledSkills } from "./skill_import.js";
import {
  loadSyncManifest,
  saveSyncManifest,
  diffSkills,
  diffAgents,
  applyDiffToManifest,
} from "./sync_manifest.js";
import { loadIdentityMap, depseudonymize } from "./identity_map.js";
import { purgeExpiredDeferredDeletes } from "./deferred_delete.js";
import type { IdentityMap } from "./discovery_types.js";
import { sanitizeForLogs } from "./tools-utils.js";
import {
  runOrchestratorTurn,
  runSubagentTask,
  type AgentContext,
  type RunCallbacks,
} from "./agent_runtime.js";
import { RunJournal } from "./run_journal.js";
import { LocalTaskManager, type LocalTaskManagerAgentContext } from "./local_task_manager.js";
import { getActiveFeature } from "../self-mod/features.js";
import { listStagedFiles } from "../self-mod/staging.js";
import { applyBatch } from "../self-mod/apply.js";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import os from "os";

const log = (...args: unknown[]) =>
  console.log("[runner]", ...args.map((entry) => sanitizeForLogs(entry)));
const logError = (...args: unknown[]) =>
  console.error("[runner]", ...args.map((entry) => sanitizeForLogs(entry)));

type HostRunnerOptions = {
  deviceId: string;
  StellaHome: string;
  frontendRoot?: string;
  signHeartbeatPayload?: (
    signedAtMs: number,
  ) => Promise<{ publicKey: string; signature: string }> | { publicKey: string; signature: string };
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
  ephemeral?: boolean;
  expiresAt?: number;
  payload?: {
    toolName?: string;
    args?: Record<string, unknown>;
    targetDeviceId?: string;
    agentType?: string;
    ephemeral?: boolean;
    expiresAt?: number;
  };
};

type DashboardGenRequestEvent = {
  _id: string;
  conversationId: string;
  type: string;
  targetDeviceId?: string;
  payload?: {
    pageId?: string;
    ownerId?: string;
    panelName?: string;
    title?: string;
    topic?: string;
    focus?: string;
    dataSources?: string[];
    systemPrompt?: string;
    userPrompt?: string;
  };
};

type PaginatedResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string | null;
};

const SYNC_DEBOUNCE_MS = 500;
const DISCOVERY_CATEGORIES_STATE_FILE = "discovery_categories.json";
const MESSAGES_NOTES_CATEGORY = "messages_notes";
const DISCOVERY_CATEGORY_CACHE_TTL_MS = 5000;
const DEFERRED_DELETE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export const createLocalHostRunner = ({
  deviceId,
  StellaHome,
  frontendRoot,
  requestCredential,
  signHeartbeatPayload,
}: HostRunnerOptions) => {
  let localTaskManager: LocalTaskManager | null = null;
  const toolHost = createToolHost({
    StellaHome,
    frontendRoot,
    taskApi: {
      createTask: async (request) => {
        if (!localTaskManager) {
          throw new Error("Local task manager not initialized");
        }
        return await localTaskManager.createTask(request);
      },
      getTask: async (taskId) => {
        if (!localTaskManager) {
          return null;
        }
        return await localTaskManager.getTask(taskId);
      },
      cancelTask: async (taskId, reason) => {
        if (!localTaskManager) {
          return { canceled: false };
        }
        return await localTaskManager.cancelTask(taskId, reason);
      },
    },
    requestCredential,
    resolveSecret: async ({ provider, secretId, requestId, toolName, deviceId: contextDeviceId }) => {
      if (!client) return null;
      if (!requestId || !toolName) return null;
      if (secretId) {
        return (await callQuery("data/secrets.getSecretValueById", {
          secretId,
          requestId,
          toolName,
          deviceId: contextDeviceId ?? deviceId,
        })) as
          | {
              secretId: string;
              provider: string;
              label: string;
              plaintext: string;
            }
          | null;
      }
      return (await callQuery("data/secrets.getSecretValueForProvider", {
        provider,
        requestId,
        toolName,
        deviceId: contextDeviceId ?? deviceId,
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
  let unsubscribeDashboardGen: (() => void) | null = null;
  let isRunning = false;
  const processed = new Set<string>();
  const inFlight = new Set<string>();
  let queue = Promise.resolve();

  // Concurrency-limited parallel executor for dashboard generation
  const MAX_CONCURRENT_DASHBOARD_GEN = 3;
  let dashboardGenRunning = 0;
  const dashboardGenPending: Array<() => void> = [];

  const runDashboardGenConcurrent = (fn: () => Promise<void>): Promise<void> => {
    if (dashboardGenRunning >= MAX_CONCURRENT_DASHBOARD_GEN) {
      return new Promise<void>((resolve) => {
        dashboardGenPending.push(() => {
          runDashboardGenConcurrent(fn).then(resolve);
        });
      });
    }
    dashboardGenRunning++;
    return fn().finally(() => {
      dashboardGenRunning--;
      const next = dashboardGenPending.shift();
      if (next) next();
    });
  };

  let syncPromise: Promise<void> | null = null;
  let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];
  let deferredDeleteSweepInterval: ReturnType<typeof setInterval> | null = null;

  let coreMemoryHash: string | null = null;
  let coreMemoryWatcher: fs.FSWatcher | null = null;
  let coreMemoryDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const CORE_MEMORY_DEBOUNCE_MS = 1000;
  const coreMemoryPath = path.join(StellaHome, "state", "CORE_MEMORY.MD");

  const syncCoreMemory = async () => {
    if (!client || !authToken) return;
    try {
      const content = await fs.promises.readFile(coreMemoryPath, "utf-8");
      if (!content.trim()) return;
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      if (hash === coreMemoryHash) return;
      await callMutation("data/preferences.setCoreMemory", { content });
      coreMemoryHash = hash;
      log("Core memory synced to Convex");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      logError("Core memory sync failed:", err);
    }
  };

  const scheduleSyncCoreMemory = () => {
    if (coreMemoryDebounceTimer) clearTimeout(coreMemoryDebounceTimer);
    coreMemoryDebounceTimer = setTimeout(() => {
      coreMemoryDebounceTimer = null;
      void syncCoreMemory();
    }, CORE_MEMORY_DEBOUNCE_MS);
  };

  const startCoreMemoryWatcher = () => {
    if (coreMemoryWatcher) return;
    const dir = path.dirname(coreMemoryPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        return;
      }
    }
    try {
      coreMemoryWatcher = fs.watch(dir, (_eventType, filename) => {
        if (filename === "CORE_MEMORY.MD") {
          scheduleSyncCoreMemory();
        }
      });
      coreMemoryWatcher.on("error", (error) => {
        logError("Core memory watcher error:", error);
      });
    } catch {
      // Watcher setup failed — sync will still happen on startup
    }
  };

  const stopCoreMemoryWatcher = () => {
    if (coreMemoryDebounceTimer) {
      clearTimeout(coreMemoryDebounceTimer);
      coreMemoryDebounceTimer = null;
    }
    if (coreMemoryWatcher) {
      coreMemoryWatcher.close();
      coreMemoryWatcher = null;
    }
  };

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const HEARTBEAT_INTERVAL_MS = 30_000;

  const sendHeartbeat = async () => {
    if (!signHeartbeatPayload) {
      logError("Heartbeat signing callback missing; skipping heartbeat.");
      return;
    }
    const signedAtMs = Date.now();
    try {
      const signed = await signHeartbeatPayload(signedAtMs);
      await callMutation("agent/device_resolver.heartbeat", {
        deviceId,
        platform: process.platform,
        signedAtMs,
        signature: signed.signature,
        publicKey: signed.publicKey,
      });
    } catch (err) {
      logError("Heartbeat failed:", err);
    }
  };

  const startHeartbeat = () => {
    if (heartbeatInterval) return;
    void sendHeartbeat();
    heartbeatInterval = setInterval(() => {
      void sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    // Best-effort goOffline — fire and forget
    callMutation("agent/device_resolver.goOffline", {}).catch(() => {});
  };

  const sweepDeferredDeletes = async (reason: "startup" | "interval") => {
    try {
      const summary = await purgeExpiredDeferredDeletes({ stellaHome: StellaHome });
      if (summary.purged > 0 || summary.errors.length > 0) {
        log("Deferred-delete sweep complete", {
          reason,
          purged: summary.purged,
          checked: summary.checked,
          skipped: summary.skipped,
          errors: summary.errors,
        });
      }
    } catch (error) {
      logError(`Deferred-delete sweep failed (${reason}):`, error);
    }
  };

  const skillsPath = path.join(StellaHome, "skills");
  const agentsPath = path.join(StellaHome, "agents");
  const statePath = path.join(StellaHome, "state");
  const discoveryCategoriesPath = path.join(
    statePath,
    DISCOVERY_CATEGORIES_STATE_FILE,
  );

  // External skill sources
  const claudeSkillsPath = path.join(os.homedir(), ".claude", "skills");
  const agentsSkillsPath = path.join(os.homedir(), ".agents", "skills");

  // Bundled Anthropic skills (shipped with the app)
  // Dev: frontendRoot/resources/bundled-skills
  // Prod: extraResources copied to process.resourcesPath/bundled-skills
  const bundledSkillsPath = (() => {
    if (frontendRoot) {
      const devPath = path.join(frontendRoot, "resources", "bundled-skills");
      if (fs.existsSync(devPath)) return devPath;
    }
    try {
      const prodPath = path.join(process.resourcesPath, "bundled-skills");
      if (fs.existsSync(prodPath)) return prodPath;
    } catch {
      // process.resourcesPath may not exist outside Electron
    }
    return null;
  })();


  const toConvexName = (name: string) => {
    // Convex expects "module:function" identifiers, not dot-separated paths.
    const firstDot = name.indexOf(".");
    if (firstDot === -1) return name;
    return `${name.slice(0, firstDot)}:${name.slice(firstDot + 1)}`;
  };

  // Direct HTTP calls to Convex — bypasses the ConvexClient WebSocket which
  // can stall indefinitely when the connection is unstable.
  const callHttp = async (
    endpoint: "mutation" | "action" | "query",
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!convexUrl || !authToken) {
      throw new Error("Runner not connected");
    }
    const convexName = toConvexName(name);
    const baseUrl = convexUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ path: convexName, args, format: "json" }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Convex ${endpoint} ${convexName} failed (${response.status}): ${text}`);
    }
    const json = await response.json();
    return json.value;
  };

  const callMutation = (name: string, args: Record<string, unknown>) => {
    if (!authToken || !convexUrl) return Promise.resolve(null);
    return callHttp("mutation", name, args);
  };

  const callQuery = (name: string, args: Record<string, unknown>) => {
    if (!authToken || !convexUrl) return Promise.resolve(null);
    return callHttp("query", name, args);
  };

  const callAction = (name: string, args: Record<string, unknown>) => {
    return callHttp("action", name, args);
  };

  const subscribeQuery = (
    name: string,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
  ): (() => void) | null => {
    if (!client || !authToken) return null;
    const convexName = toConvexName(name);
    return client.onUpdate(convexName as never, args as never, (value: unknown) => {
      onUpdate(value);
    });
  };

  localTaskManager = new LocalTaskManager({
    maxConcurrent: 3,
    fetchAgentContext: async ({ conversationId, agentType, runId, threadId }) => {
      if (!client || !authToken || !convexUrl) {
        throw new Error("Runner not connected");
      }
      return await callAction("agent/prompt_builder:fetchAgentContextForRuntime", {
        conversationId,
        agentType,
        runId,
        threadId,
      }) as LocalTaskManagerAgentContext;
    },
    runSubagent: async ({
      conversationId,
      userMessageId,
      agentType,
      taskId,
      taskDescription,
      taskPrompt,
      agentContext,
      persistToConvex,
      enableRemoteTools,
      abortSignal,
      toolExecutor,
    }) => {
      if (!authToken || !convexUrl) {
        throw new Error("Runner not connected");
      }
      return await runSubagentTask({
        conversationId,
        userMessageId,
        agentType,
        taskId,
        agentContext: agentContext as AgentContext,
        toolExecutor,
        convexUrl,
        authToken,
        deviceId,
        stellaHome: StellaHome,
        taskDescription,
        taskPrompt,
        persistToConvex,
        enableRemoteTools,
        abortSignal,
      });
    },
    toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
    createCloudTaskRecord: async ({
      conversationId,
      description,
      prompt,
      agentType,
      parentTaskId,
      commandId,
    }) => {
      const responseRaw = await callMutation("agent/tasks.createRuntimeTask", {
        conversationId,
        description,
        prompt,
        agentType,
        parentTaskId,
        commandId,
      });
      const response =
        responseRaw && typeof responseRaw === "object" && "taskId" in responseRaw
          ? responseRaw as { taskId: string }
          : null;
      if (!response) {
        throw new Error("Failed to create cloud task record");
      }
      return { taskId: response.taskId };
    },
    completeCloudTaskRecord: async ({ taskId, status, result, error }) => {
      await callMutation("agent/tasks.completeRuntimeTask", {
        taskId,
        status,
        result,
        error,
      });
    },
    getCloudTaskRecord: async (taskId) => {
      let task:
        | {
            _id: string;
            description: string;
            status: string;
            createdAt: number;
            completedAt?: number;
            result?: string;
            error?: string;
          }
        | null = null;
      try {
        task = await callQuery("agent/tasks.getRuntimeTaskById", {
          taskId,
        }) as
          | {
              _id: string;
              description: string;
              status: string;
              createdAt: number;
              completedAt?: number;
              result?: string;
              error?: string;
            }
          | null;
      } catch {
        task = null;
      }
      if (!task) return null;
      const status =
        task.status === "completed" || task.status === "error" || task.status === "canceled"
          ? task.status
          : "running";
      return {
        id: task._id,
        description: task.description,
        status,
        startedAt: task.createdAt,
        completedAt: task.completedAt ?? null,
        result: task.result,
        error: task.error,
      };
    },
    cancelCloudTaskRecord: async (taskId, reason) => {
      const response = await callMutation("agent/tasks.cancelRuntimeTask", {
        taskId,
        reason,
      });
      return { canceled: Boolean(response) };
    },
  });

  const generateMetadataViaBackend = async (
    markdown: string,
    dirName: string,
  ): Promise<{ metadata: { id: string; name: string; description: string; agentTypes: string[] } }> => {
    if (!convexUrl || !authToken) {
      throw new Error("Convex not configured");
    }
    const httpBaseUrl = convexUrl.replace(".convex.cloud", ".convex.site");
    const response = await fetch(`${httpBaseUrl}/api/generate-skill-metadata`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ markdown, skillDirName: dirName }),
    });

    if (!response.ok) {
      throw new Error(`Failed to generate metadata: ${response.status}`);
    }

    return response.json();
  };

  const syncManifests = async () => {
    const canSyncCloud = Boolean(client && authToken);
    if (syncPromise) return syncPromise;

    syncPromise = (async () => {
      try {
        log("Refreshing local manifests...");

        // Import bundled skills only when cloud sync is enabled.
        if (canSyncCloud && bundledSkillsPath) {
          try {
            await syncBundledSkills(
              bundledSkillsPath,
              skillsPath,
              statePath,
            );
          } catch (error) {
            logError("Bundled skill import failed:", error);
          }
        }



        // Import skills from external sources
        if (canSyncCloud && convexUrl && authToken) {
          try {
            await syncExternalSkills(
              claudeSkillsPath,
              agentsSkillsPath,
              skillsPath,
              statePath,
              generateMetadataViaBackend,
            );
          } catch (error) {
            logError("External skill import failed:", error);
            // Continue with manifest sync even if import fails
          }
        }

        const skills = await loadSkillsFromHome(skillsPath);
        const agents = await loadAgentsFromHome(agentsPath);

        toolHost.setSkills(skills);

        if (!canSyncCloud) {
          log("Cloud manifest sync skipped (gate disabled); local manifests refreshed");
          return;
        }

        // Best-effort: ensureBuiltins may be internal-only on some deployments
        await callMutation("agent/agents.ensureBuiltins", {}).catch(() => {});

        // Diff against persisted manifest to skip unchanged items
        const manifest = await loadSyncManifest(statePath);
        const skillsDiff = diffSkills(skills, manifest);
        const agentsDiff = diffAgents(agents, manifest);

        const dirtySkills = skillsDiff.upsert.length;
        const dirtyAgents = agentsDiff.upsert.length;
        const removedSkills = skillsDiff.removeIds.length;
        const removedAgents = agentsDiff.removeIds.length;

        if (dirtySkills === 0 && dirtyAgents === 0 && removedSkills === 0 && removedAgents === 0) {
          log("Manifest sync complete (no changes)");
          return;
        }

        if (dirtySkills > 0) {
          log(`Syncing ${dirtySkills} changed skill(s)`);
          await callMutation("data/skills.upsertMany", {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            skills: skillsDiff.upsert.map(({ filePath: _, ...rest }) => rest),
          });
        }

        if (dirtyAgents > 0) {
          log(`Syncing ${dirtyAgents} changed agent(s)`);
          await callMutation("agent/agents.upsertMany", {
            agents: agentsDiff.upsert,
          });
        }

        if (removedSkills > 0) {
          log(`Removed ${removedSkills} skill(s) from manifest (deleted from disk)`);
        }
        if (removedAgents > 0) {
          log(`Removed ${removedAgents} agent(s) from manifest (deleted from disk)`);
        }

        // Persist updated manifest only after successful sync
        const updatedManifest = applyDiffToManifest(manifest, skillsDiff, agentsDiff);
        await saveSyncManifest(statePath, updatedManifest);

        log("Manifest sync complete");

        // Sync core memory (independent of skill/agent manifests)
        await syncCoreMemory();
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
    // Only watch ~/.stella/skills and ~/.stella/agents for runtime changes.
    // External sources (.claude, .agents) and bundled skills are one-time imports
    // handled by syncManifests — no need to watch them.
    const watchDirs = [skillsPath, agentsPath];

    for (const dir of watchDirs) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          logError(`Failed to create directory: ${dir}`);
          continue;
        }
      }

      try {
        const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
          if (syncPromise) return; // Ignore events triggered by our own sync
          log(`File change: ${filename} in ${path.basename(dir)}`);
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
    if (unsubscribeDashboardGen) {
      unsubscribeDashboardGen();
      unsubscribeDashboardGen = null;
      log("Dashboard gen subscription stopped");
    }
  };

  // Track processed dashboard gen requests to avoid duplicates
  const processedDashboardGen = new Set<string>();
  const dashboardGenInFlight = new Set<string>();

  const handleDashboardGenRequest = async (request: DashboardGenRequestEvent) => {
    if (!client || !authToken || !convexUrl) return;
    if (request.type !== "dashboard_generation_request") return;

    const payload = request.payload;
    if (!payload?.pageId || !payload.panelName) return;

    const requestKey = `${request._id}:${payload.pageId}`;
    if (processedDashboardGen.has(requestKey) || dashboardGenInFlight.has(requestKey)) return;
    dashboardGenInFlight.add(requestKey);

    log("Received dashboard generation request:", {
      pageId: payload.pageId,
      panelName: payload.panelName,
      title: payload.title,
    });

    let leaseInterval: ReturnType<typeof setInterval> | null = null;
    try {
      // Claim the page lease (uses public mutation with auth)
      const claimResult = await callMutation("personalized_dashboard.claimPageGenerationDevice", {
        pageId: payload.pageId,
        claimantId: deviceId,
      }) as { claimed: boolean; claimedBy?: string } | null;

      if (!claimResult?.claimed) {
        log(`Page ${payload.pageId} already claimed by ${claimResult?.claimedBy ?? "unknown"}, skipping`);
        processedDashboardGen.add(requestKey);
        return;
      }

      // Set up lease renewal interval (every 60s)
      leaseInterval = setInterval(() => {
        void callMutation("personalized_dashboard.renewPageLeaseDevice", {
          pageId: payload.pageId,
          claimantId: deviceId,
        }).catch((err) => logError("Lease renewal failed:", err));
      }, 60_000);

      // Fetch agent context for the "general" agent type
      const agentContext = await callAction(
        "agent/prompt_builder:fetchAgentContextForRuntime",
        {
          conversationId: request.conversationId,
          agentType: "general",
          runId: `local:dash:${crypto.randomUUID()}`,
        },
      ) as AgentContext;

      // Override the system prompt with the dashboard-specific one
      if (payload.systemPrompt) {
        agentContext.systemPrompt = payload.systemPrompt;
      }

      // Compute the exact target path so the LLM doesn't have to guess
      const pagesDir = frontendRoot
        ? path.join(frontendRoot, "src", "views", "home", "pages")
        : null;
      const targetFile = pagesDir
        ? path.join(pagesDir, `${payload.panelName}.tsx`)
        : null;

      const taskPrompt = frontendRoot
        ? [
            `Your working directory is ${frontendRoot}.`,
            `Write the dashboard panel to: src/views/home/pages/${payload.panelName}.tsx`,
            ``,
            `Before writing, explore the existing pages directory (src/views/home/pages/) and`,
            `src/views/home/ to understand patterns, styling, and component structure.`,
            ``,
            payload.userPrompt ?? "",
          ].filter(Boolean).join("\n")
        : payload.userPrompt ?? `Generate the dashboard panel ${payload.panelName}.tsx`;

      // Run as a local subagent
      const result = await runSubagentTask({
        conversationId: request.conversationId,
        userMessageId: request._id,
        agentType: "general",
        agentContext,
        toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
        convexUrl,
        authToken,
        deviceId,
        stellaHome: StellaHome,
        taskDescription: `Generate personalized page: ${payload.title}`,
        taskPrompt,
        cwd: frontendRoot ?? undefined,
      });

      if (result.error) {
        logError(`Dashboard generation failed for ${payload.panelName}:`, result.error);
        await callMutation("personalized_dashboard.markPageFailedDevice", {
          pageId: payload.pageId,
          error: result.error,
        });
      } else {
        // Dashboard pages use DIRECT_WRITE_PREFIXES, so just verify on disk.
        // Support both flat file and folder/index.tsx convention.
        let hasExpectedPanelWrite = false;
        if (frontendRoot) {
          const flatPath = path.join(frontendRoot, "src", "views", "home", "pages", `${payload.panelName}.tsx`);
          const folderPath = path.join(frontendRoot, "src", "views", "home", "pages", payload.panelName, "index.tsx");
          hasExpectedPanelWrite = fs.existsSync(flatPath) || fs.existsSync(folderPath);
        }

        if (!hasExpectedPanelWrite) {
          const verificationError = `Generation finished but did not write ${payload.panelName}.tsx to src/views/home/pages.`;
          logError(verificationError, {
            pageId: payload.pageId,
            panelName: payload.panelName,
          });
          await callMutation("personalized_dashboard.markPageFailedDevice", {
            pageId: payload.pageId,
            error: verificationError,
          });
        } else {
          log(`Dashboard generation completed for ${payload.panelName}`);
          await callMutation("personalized_dashboard.markPageReadyDevice", {
            pageId: payload.pageId,
          });
        }
      }

      // Release the lease (markPageReady/Failed already clear it, but be safe)
      await callMutation("personalized_dashboard.releasePageClaimDevice", {
        pageId: payload.pageId,
        claimantId: deviceId,
      }).catch((err) => logError("Lease release failed:", err));

      processedDashboardGen.add(requestKey);
    } catch (error) {
      logError(`Dashboard gen request failed for ${payload.pageId}:`, error);
      // Release lease on error
      await callMutation("personalized_dashboard.releasePageClaimDevice", {
        pageId: payload.pageId,
        claimantId: deviceId,
      }).catch(() => {});
      processedDashboardGen.add(requestKey);
    } finally {
      if (leaseInterval) {
        clearInterval(leaseInterval);
      }
      dashboardGenInFlight.delete(requestKey);
    }
  };

  const startSubscription = () => {
    // Only start subscription if we have client, auth, and not already subscribed
    if (!client || !authToken || unsubscribe) return;

    // Look back 2 minutes to avoid missing events created just before subscription starts.
    // Dedup sets (processedDashboardGen, dashboardGenInFlight) prevent double-processing.
    const since = Date.now() - 120_000;
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
          queue = queue.then(() => handleToolRequest(request)).catch((err) => {
            logError("Tool request queue error:", err);
          });
        }
      },
    );

    // Subscribe to dashboard generation requests
    unsubscribeDashboardGen = client.onUpdate(
      "events:listDashboardGenRequestsForDevice" as never,
      { deviceId, paginationOpts: { cursor: null, numItems: 10 }, since } as never,
      (response: unknown) => {
        if (!response || typeof response !== "object" || !("page" in response)) {
          return;
        }
        const result = response as PaginatedResult<DashboardGenRequestEvent>;
        for (const request of result.page) {
          void runDashboardGenConcurrent(() => handleDashboardGenRequest(request)).catch((err) => {
            logError("Dashboard gen queue error:", err);
          });
        }
      },
    );

    log("Tool request subscription active - receiving only new requests");
  };

  // HTTP polling fallback — the WebSocket subscription may be unreliable
  // (1006 errors), so poll periodically to catch missed events.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollSince = Date.now() - 120_000;

  const pollForRequests = async () => {
    if (!authToken || !convexUrl) return;
    try {
      const events = await callQuery("events.listRecentDeviceEvents", {
        deviceId,
        since: pollSince,
        limit: 20,
      }) as Array<ToolRequestEvent | DashboardGenRequestEvent> | null;
      if (!events || events.length === 0) {
        // Advance window even with no events to avoid re-scanning old range
        pollSince = Date.now() - 10_000;
        return;
      }
      for (const event of events) {
        if (event.type === "tool_request") {
          queue = queue.then(() => handleToolRequest(event as ToolRequestEvent)).catch((err) => {
            logError("Tool request queue error (poll):", err);
          });
        } else if (event.type === "dashboard_generation_request") {
          void runDashboardGenConcurrent(() => handleDashboardGenRequest(event as DashboardGenRequestEvent)).catch((err) => {
            logError("Dashboard gen queue error (poll):", err);
          });
        }
      }
      // Advance window with 10s lookback for safety overlap
      pollSince = Date.now() - 10_000;
    } catch (err) {
      logError("Poll error:", (err as Error).message);
    }
  };

  const startPolling = () => {
    if (pollTimer) return;
    // Initial poll after a short delay, then every 10 seconds
    setTimeout(() => void pollForRequests(), 3_000);
    pollTimer = setInterval(() => void pollForRequests(), 3_000);
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  let lastSetAuthToken: string | null = null;

  const disposeClient = () => {
    stopSubscription();
    if (!client) {
      return;
    }
    client.close();
    client = null;
    lastSetAuthToken = null;
  };

  const ensureConnectedClient = () => {
    if (!convexUrl || !authToken) {
      return null;
    }
    if (!client) {
      client = new ConvexClient(convexUrl);
      lastSetAuthToken = null; // Force setAuth on new client
    }
    // Only call setAuth when the token actually changes to avoid WebSocket churn
    if (lastSetAuthToken !== authToken) {
      const token = authToken;
      lastSetAuthToken = token;
      client.setAuth(
        () => Promise.resolve(token),
        (isAuthenticated) => {
          log("ConvexClient auth state:", isAuthenticated);
        },
      );
    }
    return client;
  };

  const setConvexUrl = (url: string) => {
    const normalized = url.trim();
    if (!normalized) {
      return;
    }
    if (convexUrl === normalized && client) {
      return;
    }
    convexUrl = normalized;
    disposeClient();
    ensureConnectedClient();
    // Defer sync work until runner start to avoid duplicate startup refreshes.
    // If already running, refresh immediately for live updates.
    if (isRunning && client && authToken) {
      void syncManifests();
      startSubscription();
    }
  };

  const setAuthToken = (token: string | null) => {
    const normalizedToken =
      typeof token === "string" && token.trim().length > 0 ? token.trim() : null;

    // Skip if token hasn't changed — avoids WebSocket churn from repeated setAuth calls
    if (normalizedToken === authToken) {
      return;
    }

    authToken = normalizedToken;
    if (!authToken) {
      disposeClient();
      return;
    }
    if (!ensureConnectedClient()) {
      return;
    }
    // Start subscription if runner is running and we now have auth.
    // Note: avoid restarting an active subscription on token refresh; Convex
    // will re-authenticate as needed via the updated auth callback.
    if (isRunning) {
      startSubscription();
      startPolling();
      // Send immediate heartbeat when auth becomes available
      void sendHeartbeat();
      void syncManifests();
    }
  };

  // Identity map cache for depseudonymizing tool arguments
  let identityMapCache: IdentityMap | null = null;
  let messagesNotesEnabledCache:
    | { value: boolean; checkedAt: number }
    | null = null;

  const getIdentityMapCached = async (): Promise<IdentityMap> => {
    if (identityMapCache) return identityMapCache;
    identityMapCache = await loadIdentityMap(StellaHome);
    return identityMapCache;
  };

  const isMessagesNotesDiscoveryEnabled = async (): Promise<boolean> => {
    const now = Date.now();
    if (
      messagesNotesEnabledCache &&
      now - messagesNotesEnabledCache.checkedAt < DISCOVERY_CATEGORY_CACHE_TTL_MS
    ) {
      return messagesNotesEnabledCache.value;
    }

    try {
      const raw = await fs.promises.readFile(discoveryCategoriesPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const categories = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { categories?: unknown }).categories)
          ? (parsed as { categories: unknown[] }).categories
          : [];

      const enabled = categories.includes(MESSAGES_NOTES_CATEGORY);
      messagesNotesEnabledCache = { value: enabled, checkedAt: now };
      return enabled;
    } catch {
      messagesNotesEnabledCache = { value: false, checkedAt: now };
      return false;
    }
  };

  const depseudonymizeArgs = (
    args: Record<string, unknown>,
    map: IdentityMap,
  ): Record<string, unknown> => {
    if (!map.mappings.length) return args;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") {
        result[key] = depseudonymize(value, map);
      } else if (Array.isArray(value)) {
        result[key] = value.map((v) =>
          typeof v === "string" ? depseudonymize(v, map) : v,
        );
      } else if (value && typeof value === "object") {
        result[key] = depseudonymizeArgs(
          value as Record<string, unknown>,
          map,
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  };

  const appendToolResult = async (
    request: ToolRequestEvent,
    result: { result?: unknown; error?: string },
  ) => {
    if (!client || !request.requestId) return;
    const sanitizedResult = sanitizeForLogs(result.result);
    const sanitizedError =
      typeof result.error === "string"
        ? String(sanitizeForLogs(result.error))
        : result.error;
    await callMutation("events.appendEvent", {
      conversationId: request.conversationId,
      type: "tool_result",
      deviceId,
      requestId: request.requestId,
      targetDeviceId: request.targetDeviceId,
      ephemeral: request.ephemeral === true || request.payload?.ephemeral === true,
      ...(typeof request.expiresAt === "number" ? { expiresAt: request.expiresAt } : {}),
      payload: {
        toolName: request.payload?.toolName,
        result: sanitizedResult,
        error: sanitizedError,
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

      let toolArgs = request.payload?.args ?? {};
      if (!toolName) {
        logError("Tool request missing toolName:", request);
        await appendToolResult(request, { error: "toolName missing on request." });
        processed.add(request.requestId);
        return;
      }

      // Depseudonymize tool args: replace alias names/identifiers with real values
      // so tools operate on actual data (e.g., real contact names for iMessage queries)
      const messagesNotesEnabled = await isMessagesNotesDiscoveryEnabled();
      if (messagesNotesEnabled) {
        const idMap = await getIdentityMapCached();
        if (idMap.mappings.length > 0) {
          toolArgs = depseudonymizeArgs(toolArgs, idMap);
        }
      }

      log(`Executing tool: ${toolName}`, {
        argsPreview: JSON.stringify(sanitizeForLogs(toolArgs)).slice(0, 200),
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
    log("Starting local host runner", { deviceId, StellaHome });

    // Purge expired deferred-deletion entries (survives app restarts).
    void sweepDeferredDeletes("startup");
    if (!deferredDeleteSweepInterval) {
      deferredDeleteSweepInterval = setInterval(() => {
        void sweepDeferredDeletes("interval");
      }, DEFERRED_DELETE_SWEEP_INTERVAL_MS);
    }

    // Recover any crashed local agent runs from the journal
    void recoverCrashedRuns();

    // Initial sync on startup, then start file watchers after sync completes
    // (avoids watcher triggering on files the sync itself creates)
    void syncManifests().then(() => {
      startWatchers();
      startCoreMemoryWatcher();
    });

    // Start real-time subscription for tool requests (only if auth is ready)
    startSubscription();
    startPolling();

    // Start device heartbeat (only sends if auth is available)
    startHeartbeat();
  };

  const stop = () => {
    isRunning = false;
    if (deferredDeleteSweepInterval) {
      clearInterval(deferredDeleteSweepInterval);
      deferredDeleteSweepInterval = null;
    }
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }
    stopHeartbeat();
    stopPolling();
    stopWatchers();
    stopCoreMemoryWatcher();
    stopSubscription();
    if (client) {
      client.close();
      client = null;
    }
  };

  // ─── Local Agent Execution ────────────────────────────────────────────────

  let activeOrchestratorRunId: string | null = null;
  let activeOrchestratorConversationId: string | null = null;
  let lastAppliedFeatureId: string | null = null;
  const activeRunAbortControllers = new Map<string, AbortController>();

  const agentHealthCheck = (): { ready: boolean; runnerVersion: string } | null => {
    if (!isRunning || !client || !authToken || !convexUrl) {
      return null;
    }
    return { ready: true, runnerVersion: "1.0.0" };
  };

  const handleLocalChat = async (
    payload: {
      conversationId: string;
      userMessageId: string;
      agentType?: string;
      storageMode?: "cloud" | "local";
      localHistory?: Array<{ role: "user" | "assistant"; content: string }>;
    },
    callbacks: RunCallbacks,
  ): Promise<{ runId: string }> => {
    if (!client || !authToken || !convexUrl) {
      throw new Error("Runner not connected");
    }

    if (activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running. Wait for it to finish before starting another run.");
    }

    const agentType = payload.agentType ?? "orchestrator";
    const storageMode = payload.storageMode ?? "cloud";
    const runId = `local:${crypto.randomUUID()}`;

    // Fetch agent context from Convex
    log("Fetching agent context", { storageMode, agentType, runId });
    let agentContext: AgentContext;
    try {
      agentContext = (storageMode === "local"
        ? await callAction(
            "agent/prompt_builder:fetchLocalAgentContextForRuntime",
            {
              agentType,
              runId,
            },
          )
        : await callAction(
            "agent/prompt_builder:fetchAgentContextForRuntime",
            {
              conversationId: payload.conversationId,
              agentType,
              runId,
            },
          )) as AgentContext;
      log("Agent context fetched", {
        hasSystemPrompt: !!agentContext?.systemPrompt,
        model: agentContext?.model,
        hasProxyToken: !!agentContext?.proxyToken,
      });
    } catch (err) {
      logError("Failed to fetch agent context:", err);
      throw err;
    }

    activeOrchestratorRunId = runId;
    activeOrchestratorConversationId = payload.conversationId;
    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    // Run the agent loop
    log("Starting orchestrator turn", { runId, agentType, model: agentContext.model });
    void runOrchestratorTurn({
      runId,
      conversationId: payload.conversationId,
      userMessageId: payload.userMessageId,
      agentType,
      agentContext,
      callbacks: {
        ...callbacks,
        onEnd: async (event) => {
          activeOrchestratorRunId = null;
          activeOrchestratorConversationId = null;
          activeRunAbortControllers.delete(runId);

          // Auto-apply staged self-mod files
          if (frontendRoot) {
            try {
              const featureId = await getActiveFeature(payload.conversationId);
              if (featureId) {
                const staged = await listStagedFiles(featureId);
                if (staged.length > 0) {
                  const result = await applyBatch(featureId, frontendRoot);
                  if (result.batchIndex >= 0) {
                    lastAppliedFeatureId = featureId;
                    event.selfModApplied = {
                      featureId,
                      files: result.files,
                      batchIndex: result.batchIndex,
                    };
                    log(`Auto-applied ${result.files.length} self-mod file(s) [feature: ${featureId}]`);
                  }
                }
              }
            } catch (err) {
              logError("Self-mod auto-apply failed:", err);
            }
          }

          callbacks.onEnd(event);
        },
        onError: (event) => {
          logError("Orchestrator error:", { fatal: event.fatal, error: event.error });
          if (event.fatal) {
            activeOrchestratorRunId = null;
            activeOrchestratorConversationId = null;
            activeRunAbortControllers.delete(runId);
          }
          callbacks.onError(event);
        },
      },
      toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
      convexUrl,
      authToken,
      deviceId,
      stellaHome: StellaHome,
      localHistory: payload.localHistory,
      persistToConvex: storageMode !== "local",
      enableRemoteTools: storageMode !== "local",
      abortSignal: abortController.signal,
    });

    return { runId };
  };

  const cancelLocalChat = (runId: string): void => {
    const controller = activeRunAbortControllers.get(runId);
    if (controller) {
      controller.abort();
      activeRunAbortControllers.delete(runId);
      if (activeOrchestratorRunId === runId) {
        activeOrchestratorRunId = null;
        activeOrchestratorConversationId = null;
      }
    }
  };

  const getActiveOrchestratorRun = (): { runId: string; conversationId: string } | null => {
    if (!activeOrchestratorRunId || !activeOrchestratorConversationId) {
      return null;
    }
    return {
      runId: activeOrchestratorRunId,
      conversationId: activeOrchestratorConversationId,
    };
  };

  // Crash recovery on startup
  const recoverCrashedRuns = async () => {
    try {
      // Any process restart may leave stale background shells; clear them first.
      toolHost.killAllShells();

      const journal = new RunJournal(StellaHome);
      const crashed = journal.recoverCrashedRuns();
      for (const run of crashed) {
        log(`Recovering crashed run: ${run.runId} (${run.status})`);
        let hasPersistFailures = false;
        if (run.persistStatus === "pending" && client && authToken) {
          const chunks = journal.getUnpersistedChunks(run.runId);
          for (const chunk of chunks) {
            try {
              await callMutation("agent/tasks:batchPersistRunChunk", JSON.parse(chunk.payloadJson));
              journal.markPersisted(chunk.chunkKey);
              log(`Recovered chunk: ${chunk.chunkKey}`);
            } catch (err) {
              hasPersistFailures = true;
              logError(`Failed to recover chunk ${chunk.chunkKey}:`, err);
            }
          }
        }
        if (run.status === "running") {
          if (run.taskId) {
            try {
              await callMutation("agent/tasks.completeRuntimeTask", {
                taskId: run.taskId,
                status: "error",
                error: "Local runtime crashed before task completion.",
              });
            } catch (err) {
              logError(`Failed to mark recovered task ${run.taskId} as failed:`, err);
            }
          }
          journal.markRunCrashed(run.runId);
        } else if (!hasPersistFailures) {
          journal.markRunPersisted(run.runId);
        }
      }
      const cleaned = journal.cleanupResolvedRuns();
      if (cleaned > 0) {
        log(`Cleaned ${cleaned} resolved run journal entr${cleaned === 1 ? "y" : "ies"}.`);
      }
      journal.close();
    } catch (err) {
      logError("Crash recovery failed:", err);
    }
  };

  return {
    deviceId,
    setConvexUrl,
    setAuthToken,
    start,
    stop,
    subscribeQuery,
    getConvexUrl: () => convexUrl,
    killAllShells: () => toolHost.killAllShells(),
    killShellsByPort: (port: number) => toolHost.killShellsByPort(port),
    // Local agent execution
    agentHealthCheck,
    handleLocalChat,
    cancelLocalChat,
    getActiveOrchestratorRun,
    getLastAppliedFeatureId: () => lastAppliedFeatureId,
    recoverCrashedRuns,
  };
};
