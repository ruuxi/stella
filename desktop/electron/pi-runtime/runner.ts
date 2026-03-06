import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDevServerUrl } from "../dev-url.js";
import { createSelfModHmrController } from "../self-mod/hmr.js";
import { createToolHost } from "./extensions/stella/tools.js";
import { loadAgentsFromHome } from "./extensions/stella/agents.js";
import { loadSkillsFromHome } from "./extensions/stella/skills.js";
import {
  getCodexLocalMaxConcurrency,
  getGeneralAgentEngine,
  getModelOverride,
} from "./extensions/stella/local-preferences.js";
import { LocalTaskManager, type LocalTaskManagerAgentContext } from "./extensions/stella/local-task-manager.js";
import type { ToolContext } from "./extensions/stella/tools-types.js";
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

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const DEFAULT_MAX_TASK_DEPTH = 8;
const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Delegate specialized work with TaskCreate/Task, monitor with TaskOutput, and keep work non-blocking by default. " +
  "For bi-directional coordination, send messages to sub-agents with Task action='message' and task_id, and read incoming agent messages via Task action='inbox'.";
const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work, provide concise progress, and run tools safely. " +
  "Use Task action='inbox' to read orchestrator messages and Task action='message' to report important updates back.";

const DEFAULT_TOOL_ALLOWLIST = [
  "Read",
  "Edit",
  "Glob",
  "Grep",
  "OpenApp",
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
  "ActivateSkill",
  "NoResponse",
  "SaveMemory",
  "RecallMemories",
];

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

const sanitizeProxyBase = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.includes("/llm-proxy/")) {
    return normalized;
  }
  return `${normalized.replace(".convex.cloud", ".convex.site")}/api/ai/llm-proxy/v1`;
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
  requestCredential,
}: HostRunnerOptions) => {
  const store = new JsonlRuntimeStore(StellaHome);

  const envProxyBaseUrl = sanitizeProxyBase(process.env.STELLA_LLM_PROXY_URL ?? null);
  const envProxyToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;

  let proxyBaseUrl: string | null = envProxyBaseUrl;
  let proxyToken: string | null = envProxyToken;
  let cloudSyncEnabled = false;
  let isRunning = false;

  let localTaskManager: LocalTaskManager | null = null;
  let activeOrchestratorRunId: string | null = null;
  let activeOrchestratorConversationId: string | null = null;
  const activeRunAbortControllers = new Map<string, AbortController>();
  const activeRunHmrReleases = new Map<string, () => Promise<void>>();

  const selfModHmrController = createSelfModHmrController({
    getDevServerUrl,
    enabled: process.env.NODE_ENV === "development",
  });

  const skillsPath = path.join(StellaHome, "skills");
  const agentsPath = path.join(StellaHome, "agents");

  let loadedAgents: ParsedAgentLike[] = [];

  const toolHost = createToolHost({
    StellaHome,
    frontendRoot,
    requestCredential,
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

  const ensureProxyReady = (): { baseUrl: string; token: string } => {
    const baseUrl = sanitizeProxyBase(proxyBaseUrl);
    const token = proxyToken?.trim();
    if (!baseUrl) {
      throw new Error("Pi runtime is missing proxy URL. Set STELLA_LLM_PROXY_URL or configure host URL.");
    }
    if (!token) {
      throw new Error("Pi runtime is missing proxy token. Set STELLA_LLM_PROXY_TOKEN or auth token.");
    }
    return { baseUrl, token };
  };

  const buildAgentContext = async (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
  }): Promise<LocalTaskManagerAgentContext> => {
    const proxy = ensureProxyReady();
    const agent = resolveAgent(args.agentType);

    const modelFromPrefs = getModelOverride(StellaHome, args.agentType);
    const model = modelFromPrefs ?? agent?.model ?? process.env.STELLA_DEFAULT_MODEL ?? DEFAULT_MODEL;

    const threadHistory = store.loadThreadMessages(args.conversationId, 50);

    return {
      systemPrompt: agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
      dynamicContext: "",
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
      proxyToken: {
        token: proxy.token,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
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
      const proxy = ensureProxyReady();
      return await runPiSubagentTask({
        conversationId,
        userMessageId,
        runId: `local:sub:${crypto.randomUUID()}`,
        agentType,
        userPrompt: `${taskDescription}\n\n${taskPrompt}`,
        agentContext,
        toolExecutor,
        deviceId,
        stellaHome: StellaHome,
        proxyBaseUrl: proxy.baseUrl,
        proxyToken: proxy.token,
        getProxyToken: () => proxyToken?.trim() || proxy.token,
        store,
        abortSignal,
        onProgress,
      });
    },
    toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
    createCloudTaskRecord: async () => ({ taskId: `local:task:${crypto.randomUUID()}` }),
    completeCloudTaskRecord: async () => {},
    getCloudTaskRecord: async () => null,
    cancelCloudTaskRecord: async () => ({ canceled: false }),
  });

  const setConvexUrl = (value: string | null) => {
    if (envProxyBaseUrl) return;
    proxyBaseUrl = sanitizeProxyBase(value);
  };

  const setAuthToken = (value: string | null) => {
    if (envProxyToken) return;
    proxyToken = value;
  };

  const setCloudSyncEnabled = (enabled: boolean) => {
    cloudSyncEnabled = Boolean(enabled);
    if (!cloudSyncEnabled) {
      // Local Pi runtime intentionally ignores cloud persistence.
    }
  };

  const start = () => {
    if (isRunning) return;
    isRunning = true;

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
    activeOrchestratorRunId = null;
    activeOrchestratorConversationId = null;
    for (const controller of activeRunAbortControllers.values()) {
      controller.abort();
    }
    activeRunAbortControllers.clear();
    for (const release of activeRunHmrReleases.values()) {
      void release();
    }
    activeRunHmrReleases.clear();
    void selfModHmrController.forceResumeAll();
    toolHost.killAllShells();
    shutdownPiSubagentRuntimes();
  };

  const agentHealthCheck = (): AgentHealth => {
    if (!isRunning) {
      return { ready: false, reason: "Pi runtime is not started", engine: "pi" };
    }
    const hasProxyUrl = Boolean(sanitizeProxyBase(proxyBaseUrl));
    const hasProxyToken = Boolean(proxyToken?.trim());
    if (!hasProxyUrl) {
      return { ready: false, reason: "Missing proxy URL", engine: "pi" };
    }
    if (!hasProxyToken) {
      return { ready: false, reason: "Missing proxy token", engine: "pi" };
    }
    return { ready: true, engine: "pi" };
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
    const proxy = ensureProxyReady();
    const updateMessage = "Stella is updating your interface.";

    if (!userPrompt) {
      throw new Error("Missing user prompt");
    }

    const agentContext = await buildAgentContext({
      conversationId,
      agentType,
      runId,
    });

    activeOrchestratorRunId = runId;
    activeOrchestratorConversationId = conversationId;

    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    callbacks.onSelfModHmrState?.({
      paused: true,
      message: updateMessage,
    });
    const pauseApplied = await selfModHmrController.pause(runId);
    if (!pauseApplied) {
      console.warn("[self-mod-hmr] Pause endpoint unavailable; proceeding without HMR pause.");
    }

    let hmrReleased = false;
    const releaseHmrPause = async () => {
      if (hmrReleased) return;
      hmrReleased = true;
      activeRunHmrReleases.delete(runId);

      const doResume = async () => {
        try {
          const resumeApplied = await selfModHmrController.resume(runId);
          if (!resumeApplied) {
            console.warn("[self-mod-hmr] Resume endpoint unavailable.");
          }
        } catch (error) {
          console.warn("[self-mod-hmr] Failed to resume:", (error as Error).message);
        }
      };

      try {
        if (callbacks.onHmrResume) {
          await callbacks.onHmrResume(doResume);
        } else {
          await doResume();
        }
      } finally {
        callbacks.onSelfModHmrState?.({
          paused: false,
          message: "",
        });
      }
    };
    activeRunHmrReleases.set(runId, releaseHmrPause);

    const cleanupRun = () => {
      activeRunAbortControllers.delete(runId);
      if (activeOrchestratorRunId === runId) {
        activeOrchestratorRunId = null;
        activeOrchestratorConversationId = null;
      }
      void releaseHmrPause();
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
      proxyBaseUrl: proxy.baseUrl,
      proxyToken: proxy.token,
      getProxyToken: () => proxyToken?.trim() || proxy.token,
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

  const cancelLocalChat = (runId: string) => {
    const controller = activeRunAbortControllers.get(runId);
    if (!controller) return;
    controller.abort();
    activeRunAbortControllers.delete(runId);
    const release = activeRunHmrReleases.get(runId);
    if (release) {
      void release();
    }
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
    subscribeQuery: () => null,
    getConvexUrl: () => proxyBaseUrl,
    killAllShells: () => toolHost.killAllShells(),
    killShellsByPort: (port: number) => toolHost.killShellsByPort(port),
    executeTool: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      context: ToolContext,
    ) => toolHost.executeTool(toolName, toolArgs, context),
    agentHealthCheck,
    handleLocalChat,
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
