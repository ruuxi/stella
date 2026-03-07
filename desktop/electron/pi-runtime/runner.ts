import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { getDevServerUrl } from "../dev-url.js";
import { createSelfModHmrController } from "../self-mod/hmr.js";
import type { HmrMorphOrchestrator } from "../self-mod/hmr-morph.js";
import { createToolHost } from "./extensions/stella/tools.js";
import { loadAgentsFromHome } from "./extensions/stella/agents.js";
import { loadSkillsFromHome } from "./extensions/stella/skills.js";
import {
  getCodexLocalMaxConcurrency,
  getGeneralAgentEngine,
  getModelOverride,
} from "./extensions/stella/local-preferences.js";
import { LocalTaskManager, type LocalTaskManagerAgentContext } from "./extensions/stella/local-task-manager.js";
import type { ScheduleToolApi, ToolContext } from "./extensions/stella/tools-types.js";
import { JsonlRuntimeStore } from "./jsonl_store.js";
import {
  runPiOrchestratorTurn,
  runPiSubagentTask,
  shutdownPiSubagentRuntimes,
  type PiEndEvent,
  type PiErrorEvent,
  type PiRunCallbacks,
  type PiStreamEvent,
  type PiToolEndEvent,
  type PiToolStartEvent,
} from "./pi_agent_runtime.js";
import { canResolveLlmRoute, resolveLlmRoute } from "./model-routing.js";
import { createRemoteTurnBridge } from "./remote-turn-bridge.js";

const DEFAULT_MAX_TASK_DEPTH = 8;
// Minimal fallback prompts — real prompts live in bundled AGENT.md files
// seeded to ~/.stella/agents/ on first startup.
const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Delegate specialized work with TaskCreate/Task, monitor with TaskOutput, and keep work non-blocking by default. " +
  "For bi-directional coordination, send messages to sub-agents with Task action='message' and task_id, and read incoming agent messages via Task action='inbox'. " +
  "You can interact with Stella's desktop UI via `stella-ui snapshot`, `stella-ui click @ref`, `stella-ui fill @ref \"text\"` in Bash.";
const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work, provide concise progress, and run tools safely. " +
  "Use Task action='inbox' to read orchestrator messages and Task action='message' to report important updates back. " +
  "When creating or modifying UI components, add data-stella-label, data-stella-state, and data-stella-action attributes.";

const DEFAULT_TOOL_ALLOWLIST = [
  "Read",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "ShellStatus",
  "AskUserQuestion",
  "RequestCredential",
  "SkillBash",
  "Task",
  "TaskCreate",
  "TaskCancel",
  "TaskOutput",
  "WebFetch",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
  "ActivateSkill",
  "NoResponse",
  "SaveMemory",
  "RecallMemories",
];

type HostRunnerOptions = {
  deviceId: string;
  StellaHome: string;
  frontendRoot?: string;
  getHmrMorphOrchestrator?: () => HmrMorphOrchestrator | null;
  signHeartbeatPayload?: (
    signedAtMs: number,
  ) => Promise<{ publicKey: string; signature: string }> | { publicKey: string; signature: string };
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  scheduleApi?: ScheduleToolApi;
};

type ChatPayload = {
  conversationId: string;
  userMessageId: string;
  userPrompt: string;
  agentType?: string;
  storageMode?: "cloud" | "local";
};

type AgentHealth = {
  ready: boolean;
  reason?: string;
  engine?: string;
};

type AgentCallbacks = {
  onStream: (event: PiStreamEvent) => void;
  onToolStart: (event: PiToolStartEvent) => void;
  onToolEnd: (event: PiToolEndEvent) => void;
  onError: (event: PiErrorEvent) => void;
  onEnd: (event: PiEndEvent) => void;
  onSelfModHmrState?: (event: { paused: boolean; message: string }) => void;
  onHmrResume?: (resumeHmr: () => Promise<void>) => Promise<void>;
};

type ParsedAgentLike = {
  id: string;
  name: string;
  systemPrompt: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  defaultSkills?: string[];
  model?: string;
  maxTaskDepth?: number;
};

const defaultPromptForAgentType = (agentType: string): string => {
  if (agentType === "orchestrator") return DEFAULT_ORCHESTRATOR_PROMPT;
  return DEFAULT_SUBAGENT_PROMPT;
};

const sanitizeConvexDeploymentUrl = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
};

const sanitizeProxyBase = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.includes("/api/ai/v1")) {
    return normalized;
  }
  return `${normalized.replace(".convex.cloud", ".convex.site")}/api/ai/v1`;
};

/** Scan source files for data-stella-label attributes to build panel inventory. */
const buildPanelInventory = (frontendRoot: string): string => {
  const labelPattern = /data-stella-label="([^"]+)"/g;
  const labels = new Set<string>();

  // Scan home view components
  const homeDir = path.join(frontendRoot, "src", "app", "home");
  // Scan workspace pages
  const pagesDir = path.join(frontendRoot, "src", "views", "home", "pages");

  for (const dir of [homeDir, pagesDir]) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!/\.(tsx|jsx)$/.test(entry)) continue;
        try {
          const source = fs.readFileSync(path.join(dir, entry), "utf-8");
          let match;
          while ((match = labelPattern.exec(source)) !== null) {
            labels.add(match[1]);
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* directory doesn't exist */ }
  }

  if (labels.size === 0) return "";
  return "Current panels on the home view (visible to the user right now): " + [...labels].join(", ");
};

const readCoreMemory = (stellaHome: string): string | undefined => {
  const filePath = path.join(stellaHome, "state", "CORE_MEMORY.MD");
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

export const createPiHostRunner = ({
  deviceId,
  StellaHome,
  frontendRoot,
  getHmrMorphOrchestrator,
  requestCredential,
  scheduleApi,
}: HostRunnerOptions) => {
  const store = new JsonlRuntimeStore(StellaHome);
  const convexApi = anyApi;

  const envProxyBaseUrl = sanitizeProxyBase(process.env.STELLA_LLM_PROXY_URL ?? null);
  const envAuthToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;
  const envConvexDeploymentUrl = sanitizeConvexDeploymentUrl(process.env.STELLA_CONVEX_URL ?? null);

  let proxyBaseUrl: string | null = envProxyBaseUrl;
  let authToken: string | null = envAuthToken;
  let convexDeploymentUrl: string | null = envConvexDeploymentUrl;
  let convexClient: ConvexClient | null = null;
  let convexClientUrl: string | null = null;
  let cloudSyncEnabled = false;
  let isRunning = false;

  let localTaskManager: LocalTaskManager | null = null;
  let activeOrchestratorRunId: string | null = null;
  let activeOrchestratorConversationId: string | null = null;
  const activeRunAbortControllers = new Map<string, AbortController>();

  const selfModHmrController = createSelfModHmrController({
    getDevServerUrl,
    enabled: process.env.NODE_ENV === "development",
  });

  const skillsPath = path.join(StellaHome, "skills");
  const agentsPath = path.join(StellaHome, "agents");

  let loadedAgents: ParsedAgentLike[] = [];

  const disposeConvexClient = () => {
    const client = convexClient;
    convexClient = null;
    convexClientUrl = null;
    if (client) {
      void client.close().catch(() => undefined);
    }
  };

  const ensureConvexClient = (): ConvexClient | null => {
    const deploymentUrl = sanitizeConvexDeploymentUrl(convexDeploymentUrl);
    if (!deploymentUrl) {
      disposeConvexClient();
      return null;
    }

    if (convexClient && convexClientUrl === deploymentUrl) {
      return convexClient;
    }

    disposeConvexClient();
    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => authToken?.trim() || null);
    convexClient = client;
    convexClientUrl = deploymentUrl;
    return client;
  };

  const refreshConvexAuth = () => {
    if (!convexClient) {
      return;
    }
    convexClient.setAuth(async () => authToken?.trim() || null);
  };

  const toolHost = createToolHost({
    StellaHome,
    frontendRoot,
    requestCredential,
    scheduleApi,
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
      sendTaskMessage: async (taskId, message, from) => {
        if (!localTaskManager || typeof localTaskManager.sendTaskMessage !== "function") {
          return { delivered: false };
        }
        return await localTaskManager.sendTaskMessage(taskId, message, from);
      },
      drainTaskMessages: async (taskId, recipient) => {
        if (!localTaskManager || typeof localTaskManager.drainTaskMessages !== "function") {
          return [];
        }
        return await localTaskManager.drainTaskMessages(taskId, recipient);
      },
    },
  });

  const resolveAgent = (agentType: string): ParsedAgentLike | undefined => {
    return loadedAgents.find((entry) => entry.agentTypes.includes(agentType))
      ?? loadedAgents.find((entry) => entry.id === agentType);
  };

  const ensureProxyReady = (): { baseUrl: string; authToken: string } => {
    const baseUrl = sanitizeProxyBase(proxyBaseUrl);
    const nextAuthToken = authToken?.trim();
    if (!baseUrl) {
      throw new Error("Pi runtime is missing proxy URL. Set STELLA_LLM_PROXY_URL or configure host URL.");
    }
    if (!nextAuthToken) {
      throw new Error("Pi runtime is missing auth token. Sign in or set STELLA_LLM_PROXY_TOKEN.");
    }
    return { baseUrl, authToken: nextAuthToken };
  };

  const getConfiguredModel = (agentType: string, agent?: ParsedAgentLike | undefined): string | undefined => {
    const modelFromPrefs = getModelOverride(StellaHome, agentType);
    return modelFromPrefs ?? agent?.model ?? process.env.STELLA_DEFAULT_MODEL;
  };

  const buildAgentContext = async (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
  }): Promise<LocalTaskManagerAgentContext> => {
    const agent = resolveAgent(args.agentType);
    const model = getConfiguredModel(args.agentType, agent);

    const threadHistory = store.loadThreadMessages(args.conversationId, 50);
    return {
      systemPrompt: agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
      dynamicContext:
        args.agentType === "orchestrator" && frontendRoot
          ? buildPanelInventory(frontendRoot)
          : "",
      toolsAllowlist: agent?.toolsAllowlist?.length ? agent.toolsAllowlist : DEFAULT_TOOL_ALLOWLIST,
      model,
      maxTaskDepth: agent?.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH,
      defaultSkills: agent?.defaultSkills ?? [],
      skillIds: [],
      coreMemory: readCoreMemory(StellaHome),
      threadHistory: threadHistory.length > 0 ? threadHistory : undefined,
      activeThreadId: args.threadId,
      generalAgentEngine: args.agentType === "general" ? getGeneralAgentEngine(StellaHome) : undefined,
      codexLocalMaxConcurrency:
        args.agentType === "general" ? getCodexLocalMaxConcurrency(StellaHome) : undefined,
    };
  };

  localTaskManager = new LocalTaskManager({
    maxConcurrent: 3,
    fetchAgentContext: buildAgentContext,
    runSubagent: async ({
      conversationId,
      userMessageId,
      agentType,
      agentContext,
      taskDescription,
      taskPrompt,
      abortSignal,
      onProgress,
      toolExecutor,
    }) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const shouldControlHmr = agentType === "general";
      const pauseApplied = shouldControlHmr
        ? await selfModHmrController.pause(runId)
        : true;

      if (shouldControlHmr && !pauseApplied) {
        console.warn("[self-mod-hmr] Pause endpoint unavailable for general subagent.");
      }

      const resolvedLlm = resolveLlmRoute({
        stellaHomePath: StellaHome,
        modelName: agentContext.model,
        agentType,
        proxy: {
          baseUrl: proxyBaseUrl,
          getAuthToken: () => authToken?.trim(),
        },
      });
      try {
        return await runPiSubagentTask({
          conversationId,
          userMessageId,
          runId,
          agentType,
          userPrompt: `${taskDescription}\n\n${taskPrompt}`,
          agentContext,
          toolExecutor,
          deviceId,
          stellaHome: StellaHome,
          resolvedLlm,
          store,
          abortSignal,
          onProgress,
        });
      } finally {
        if (shouldControlHmr) {
          const status = await selfModHmrController.getStatus().catch(() => null);
          const shouldMorph = Boolean(
            status && (status.queuedFiles > 0 || status.requiresFullReload),
          );
          const resumeHmr = async () => {
            const resumeApplied = await selfModHmrController.resume(runId);
            if (!resumeApplied) {
              console.warn("[self-mod-hmr] Resume endpoint unavailable for general subagent.");
            }
          };

          try {
            const morphOrchestrator = getHmrMorphOrchestrator?.() ?? null;
            if (shouldMorph && morphOrchestrator) {
              await morphOrchestrator.runTransition({ resumeHmr });
            } else {
              await resumeHmr();
            }
          } catch (error) {
            console.warn("[self-mod-hmr] Failed to resume general subagent HMR:", (error as Error).message);
            await selfModHmrController.resume(runId).catch(() => undefined);
          }
        }
      }
    },
    toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
    createCloudTaskRecord: async () => ({ taskId: `local:task:${crypto.randomUUID()}` }),
    completeCloudTaskRecord: async () => {},
    getCloudTaskRecord: async () => null,
    cancelCloudTaskRecord: async () => ({ canceled: false }),
  });

  const setConvexUrl = (value: string | null) => {
    if (!envConvexDeploymentUrl) {
      const nextConvexDeploymentUrl = sanitizeConvexDeploymentUrl(value);
      if (nextConvexDeploymentUrl !== convexClientUrl) {
        disposeConvexClient();
      }
      convexDeploymentUrl = nextConvexDeploymentUrl;
    }
    if (!envProxyBaseUrl) {
      proxyBaseUrl = sanitizeProxyBase(value);
    }
    syncRemoteTurnBridge();
  };

  const setAuthToken = (value: string | null) => {
    if (envAuthToken) return;
    authToken = value;
    refreshConvexAuth();
    syncRemoteTurnBridge();
  };

  const setCloudSyncEnabled = (enabled: boolean) => {
    cloudSyncEnabled = Boolean(enabled);
    syncRemoteTurnBridge();
  };

  const start = () => {
    if (isRunning) return;
    isRunning = true;
    syncRemoteTurnBridge();

    void loadSkillsFromHome(skillsPath)
      .then((skills) => {
        toolHost.setSkills(skills);
      })
      .catch(() => {
        // Skills are optional at startup.
      });

    void loadAgentsFromHome(agentsPath)
      .then((agents) => {
        loadedAgents = agents;
      })
      .catch(() => {
        loadedAgents = [];
      });
  };

  const stop = () => {
    isRunning = false;
    remoteTurnBridge.stop();
    disposeConvexClient();
    activeOrchestratorRunId = null;
    activeOrchestratorConversationId = null;
    for (const controller of activeRunAbortControllers.values()) {
      controller.abort();
    }
    activeRunAbortControllers.clear();
    void selfModHmrController.forceResumeAll();
    toolHost.killAllShells();
    shutdownPiSubagentRuntimes();
    store.close();
  };

  const agentHealthCheck = (): AgentHealth => {
    if (!isRunning) {
      return { ready: false, reason: "Pi runtime is not started", engine: "pi" };
    }
    const orchestratorModel = getConfiguredModel("orchestrator", resolveAgent("orchestrator"));
    if (canResolveLlmRoute({
      stellaHomePath: StellaHome,
      modelName: orchestratorModel,
      proxy: {
        baseUrl: proxyBaseUrl,
        getAuthToken: () => authToken?.trim(),
      },
    })) {
      return { ready: true, engine: "pi" };
    }
    const hasProxyUrl = Boolean(sanitizeProxyBase(proxyBaseUrl));
    const hasAuthToken = Boolean(authToken?.trim());
    if (!hasProxyUrl) {
      return { ready: false, reason: "Missing proxy URL", engine: "pi" };
    }
    if (!hasAuthToken) {
      return { ready: false, reason: "Missing auth token", engine: "pi" };
    }
    return { ready: false, reason: "No usable model route", engine: "pi" };
  };

  const handleLocalChat = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Pi runtime not ready");
    }

    if (activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running. Wait for it to finish before starting another run.");
    }

    const conversationId = payload.conversationId;
    const runId = `local:${crypto.randomUUID()}`;
    const agentType = payload.agentType ?? "orchestrator";
    const userPrompt = payload.userPrompt.trim();
    if (!userPrompt) {
      throw new Error("Missing user prompt");
    }

    const agentContext = await buildAgentContext({
      conversationId,
      agentType,
      runId,
    });
    const resolvedLlm = resolveLlmRoute({
      stellaHomePath: StellaHome,
      modelName: agentContext.model,
      agentType,
      proxy: {
        baseUrl: proxyBaseUrl,
        getAuthToken: () => authToken?.trim(),
      },
    });

    console.log(`[stella:trace] handleLocalChat | runId=${runId} | agent=${agentType} | model=${agentContext.model} | resolvedModel=${resolvedLlm.model} | convId=${conversationId}`);
    console.log(`[stella:trace] handleLocalChat | tools=[${(agentContext.toolsAllowlist ?? []).join(", ")}]`);
    console.log(`[stella:trace] handleLocalChat | threadHistory=${agentContext.threadHistory?.length ?? 0} messages`);

    activeOrchestratorRunId = runId;
    activeOrchestratorConversationId = conversationId;

    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    const cleanupRun = () => {
      activeRunAbortControllers.delete(runId);
      if (activeOrchestratorRunId === runId) {
        activeOrchestratorRunId = null;
        activeOrchestratorConversationId = null;
      }
    };

    const runtimeCallbacks: PiRunCallbacks = {
      onStream: callbacks.onStream,
      onToolStart: callbacks.onToolStart,
      onToolEnd: callbacks.onToolEnd,
      onError: (event) => {
        callbacks.onError(event);
        if (event.fatal) {
          cleanupRun();
        }
      },
      onEnd: (event) => {
        cleanupRun();
        callbacks.onEnd(event);
      },
    };

    void runPiOrchestratorTurn({
      runId,
      conversationId,
      userMessageId: payload.userMessageId,
      agentType,
      userPrompt,
      agentContext,
      callbacks: runtimeCallbacks,
      toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
      deviceId,
      stellaHome: StellaHome,
      resolvedLlm,
      store,
      abortSignal: abortController.signal,
      frontendRoot,
    }).catch((error) => {
      cleanupRun();
      callbacks.onError({
        runId,
        seq: Date.now(),
        error: (error as Error).message || "Pi runtime failed",
        fatal: true,
      });
    });

    return { runId };
  };

  const runAutomationTurn = async (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
  }): Promise<
    | { status: "ok"; finalText: string }
    | { status: "busy"; finalText: ""; error: string }
    | { status: "error"; finalText: ""; error: string }
  > => {
    const health = agentHealthCheck();
    if (!health.ready) {
      return {
        status: "error",
        finalText: "",
        error: health.reason ?? "Pi runtime not ready",
      };
    }

    if (activeOrchestratorRunId) {
      return {
        status: "busy",
        finalText: "",
        error: "The orchestrator is already running.",
      };
    }

    const conversationId = payload.conversationId.trim();
    const userPrompt = payload.userPrompt.trim();
    const agentType = payload.agentType ?? "orchestrator";
    if (!conversationId) {
      return { status: "error", finalText: "", error: "Missing conversationId" };
    }
    if (!userPrompt) {
      return { status: "error", finalText: "", error: "Missing user prompt" };
    }

    const runId = `local:auto:${crypto.randomUUID()}`;
    const agentContext = await buildAgentContext({
      conversationId,
      agentType,
      runId,
    });
    const resolvedLlm = resolveLlmRoute({
      stellaHomePath: StellaHome,
      modelName: agentContext.model,
      agentType,
      proxy: {
        baseUrl: proxyBaseUrl,
        getAuthToken: () => authToken?.trim(),
      },
    });

    activeOrchestratorRunId = runId;
    activeOrchestratorConversationId = conversationId;

    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    const cleanupRun = () => {
      activeRunAbortControllers.delete(runId);
      if (activeOrchestratorRunId === runId) {
        activeOrchestratorRunId = null;
        activeOrchestratorConversationId = null;
      }
    };

    let finalText = "";
    let fatalError: string | null = null;

    try {
      await runPiOrchestratorTurn({
        runId,
        conversationId,
        userMessageId: `automation:${crypto.randomUUID()}`,
        agentType,
        userPrompt,
        agentContext,
        callbacks: {
          onStream: () => {},
          onToolStart: () => {},
          onToolEnd: () => {},
          onError: (event) => {
            if (event.fatal) {
              fatalError = event.error;
            }
          },
          onEnd: (event) => {
            finalText = event.finalText;
          },
        },
        toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
        deviceId,
        stellaHome: StellaHome,
        resolvedLlm,
        store,
        abortSignal: abortController.signal,
        frontendRoot,
      });
      if (fatalError) {
        return { status: "error", finalText: "", error: fatalError };
      }
      return { status: "ok", finalText };
    } catch (error) {
      return {
        status: "error",
        finalText: "",
        error: (error as Error).message || "Pi runtime failed",
      };
    } finally {
      cleanupRun();
    }
  };

  const remoteTurnBridge = createRemoteTurnBridge({
    deviceId,
    isEnabled: () => isRunning && cloudSyncEnabled,
    isRunnerBusy: () => Boolean(activeOrchestratorRunId),
    subscribeRemoteTurnRequests: ({
      deviceId: targetDeviceId,
      since,
      onUpdate,
      onError,
    }) => {
      const client = ensureConvexClient();
      if (!client) {
        return () => {};
      }

      const subscription = client.onUpdate(
        convexApi.events.subscribeRemoteTurnRequestsForDevice,
        {
          deviceId: targetDeviceId,
          since,
          limit: 20,
        },
        (events) => {
          onUpdate(events as Array<{
            _id: string;
            timestamp: number;
            type: string;
            requestId?: string;
            payload?: Record<string, unknown>;
          }>);
        },
        onError,
      );

      return () => {
        subscription.unsubscribe();
      };
    },
    runLocalTurn: async ({ conversationId, userPrompt, agentType }) =>
      await runAutomationTurn({ conversationId, userPrompt, agentType }),
    completeConnectorTurn: async ({ requestId, conversationId, text }) => {
      const client = ensureConvexClient();
      if (!client) {
        throw new Error("Missing Convex client configuration.");
      }
      await client.mutation(
        convexApi.channels.connector_delivery.completeRemoteTurn,
        { requestId, conversationId, text },
      );
    },
    log: (level, message, error) => {
      const logger = level === "error" ? console.error : console.warn;
      if (error === undefined) {
        logger(message);
        return;
      }
      logger(message, error);
    },
  });

  function syncRemoteTurnBridge() {
    if (!isRunning || !cloudSyncEnabled) {
      remoteTurnBridge.stop();
      return;
    }
    remoteTurnBridge.start();
    remoteTurnBridge.kick();
  }

  const cancelLocalChat = (runId: string) => {
    const controller = activeRunAbortControllers.get(runId);
    if (!controller) return;
    controller.abort();
    activeRunAbortControllers.delete(runId);
    if (activeOrchestratorRunId === runId) {
      activeOrchestratorRunId = null;
      activeOrchestratorConversationId = null;
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

  const recoverCrashedRuns = async () => {
    // JSONL runtime is append-only and local-first; no crash recovery migration needed.
  };

  return {
    deviceId,
    setConvexUrl,
    setAuthToken,
    setCloudSyncEnabled,
    start,
    stop,
    subscribeQuery: (query: unknown, args: Record<string, unknown>, onUpdate: (value: unknown) => void, onError?: (error: Error) => void) => {
      const client = ensureConvexClient();
      if (!client) {
        return null;
      }
      const subscription = client.onUpdate(
        query as never,
        args as never,
        onUpdate as never,
        onError,
      );
      return () => {
        subscription.unsubscribe();
      };
    },
    getConvexUrl: () => proxyBaseUrl,
    getProxy: (): { baseUrl: string; authToken: string } | null => {
      try { return ensureProxyReady(); } catch { return null; }
    },
    killAllShells: () => toolHost.killAllShells(),
    killShellsByPort: (port: number) => toolHost.killShellsByPort(port),
    executeTool: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      context: ToolContext,
    ) => toolHost.executeTool(toolName, toolArgs, context),
    agentHealthCheck,
    handleLocalChat,
    runAutomationTurn,
    cancelLocalChat,
    getActiveOrchestratorRun,
    recoverCrashedRuns,
    appendThreadMessage: (args: {
      conversationId: string;
      role: "user" | "assistant";
      content: string;
    }) => {
      store.appendThreadMessage({ ...args, timestamp: Date.now() });
    },
  };
};
