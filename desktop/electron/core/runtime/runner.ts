import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { createToolHost } from "./tools/host.js";
import type { ScheduleToolApi } from "./tools/types.js";
import type { ToolContext } from "./tools/types.js";
import { loadAgentsFromHome } from "./agents/agents.js";
import type { ParsedSkill } from "./agents/manifests.js";
import { loadSkillsFromHome } from "./agents/skills.js";
import { loadExtensions } from "./extensions/loader.js";
import { HookEmitter } from "./extensions/hook-emitter.js";
import {
  getDefaultModel,
  getGeneralAgentEngine,
  getMaxAgentConcurrency,
  getModelOverride,
  getSelfModAgentEngine,
} from "./preferences/local-preferences.js";
import { LocalTaskManager, type LocalTaskManagerAgentContext, type TaskLifecycleEvent } from "./tasks/local-task-manager.js";
import type { RuntimeStore } from "../../storage/runtime-store.js";
import { buildLocalHistoryFromEvents, type LocalContextEvent } from "./local-history.js";
import {
  runOrchestratorTurn,
  runSubagentTask,
  shutdownSubagentRuntimes,
  type SelfModMonitor,
  type RuntimeEndEvent,
  type RuntimeErrorEvent,
  type RuntimeRunCallbacks,
  type RuntimeStreamEvent,
  type RuntimeToolEndEvent,
  type RuntimeToolStartEvent,
} from "./agent-runtime.js";
import { registerModel } from "../ai/models.js";
import type { Api, Model } from "../ai/types.js";
import { canResolveLlmRoute, resolveLlmRoute } from "./model-routing.js";
import { createRemoteTurnBridge } from "./remote-turn-bridge.js";
import { normalizeStellaApiBaseUrl } from "./stella-provider.js";
import type { SelfModHmrState } from "../../../src/shared/contracts/electron-data.js";
import {
  buildRuntimeThreadKey,
  parseThreadCheckpoint,
} from "./thread-runtime.js";
import { buildActiveThreadsPrompt } from "./runtime-threads.js";

const DEFAULT_MAX_TASK_DEPTH = 8;
const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
const MIN_LOCAL_HISTORY_TOKENS = 8_000;
// Minimal fallback prompts in case bundled core agents and local overrides both fail to load.
const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Coordinate specialized work and keep work non-blocking by default. " +
  "For user-facing output, prefer Display for most substantive, structured, or multi-item responses and keep plain text mainly for acknowledgments, brief confirmations, and short replies. " +
  "After using Display, keep any chat text to one short sentence unless the user explicitly asks for detailed text. " +
  "You can interact with Stella's desktop UI via `stella-ui snapshot`, `stella-ui click @ref`, `stella-ui fill @ref \"text\"` in Bash.";
const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work directly, provide concise progress, and run tools safely. " +
  "When creating or modifying UI components, add data-stella-label, data-stella-state, and data-stella-action attributes.";

const LOCAL_CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_request",
  "tool_result",
  "task_started",
  "task_completed",
  "task_failed",
  "task_canceled",
  "microcompact_boundary",
]);

export type StellaHostRunnerOptions = {
  deviceId: string;
  StellaHome: string;
  frontendRoot?: string;
  stellaBrowserBinPath?: string;
  stellaUiCliPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModHmrController?: {
    pause: (runId: string) => Promise<boolean>;
    resume: (runId: string) => Promise<boolean>;
    forceResumeAll: () => Promise<boolean>;
    getStatus: () => Promise<{ queuedFiles: number; requiresFullReload: boolean } | null>;
  } | null;
  getHmrMorphOrchestrator?: () => {
    runTransition: (args: {
      resumeHmr: () => Promise<void>;
      reportState?: (state: SelfModHmrState) => void;
      requiresFullReload: boolean;
    }) => Promise<void>;
  } | null;
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
  displayHtml?: (html: string) => void;
  runtimeStore: RuntimeStore;
  listLocalChatEvents?: (conversationId: string, maxItems: number) => LocalContextEvent[];
};

type SearchHtmlPromptConfig = {
  systemPrompt: string;
  userPromptTemplate: string;
};

type ChatPayload = {
  conversationId: string;
  userMessageId: string;
  userPrompt: string;
  agentType?: string;
  storageMode?: "cloud" | "local";
  searchHtmlPrompts?: SearchHtmlPromptConfig;
};

type AgentHealth = {
  ready: boolean;
  reason?: string;
  engine?: string;
};

type AgentCallbacks = {
  onStream: (event: RuntimeStreamEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onTaskEvent?: (event: TaskLifecycleEvent) => void;
  onSelfModHmrState?: (event: SelfModHmrState) => void;
  onHmrResume?: (args: {
    resumeHmr: () => Promise<void>;
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }) => Promise<void>;
};

const createSelfModHmrState = (
  phase: SelfModHmrState["phase"],
  paused: boolean,
  requiresFullReload = false,
): SelfModHmrState => ({
  phase,
  paused,
  requiresFullReload,
});

type QueuedOrchestratorTurn = {
  priority: "user" | "system";
  requeueOnInterrupt: boolean;
  execute: () => Promise<void>;
};

const QUEUED_TURN_INTERRUPT_ERROR = "Interrupted by queued orchestrator turn";

type ParsedAgentLike = {
  id: string;
  name: string;
  systemPrompt: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  delegationAllowlist?: string[];
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

const sanitizeStellaBase = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.includes("/api/stella/v1")) {
    return normalizeStellaApiBaseUrl(normalized);
  }
  return `${normalized.replace(".convex.cloud", ".convex.site")}/api/stella/v1`;
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

const buildTaskEventPrompt = (event: TaskLifecycleEvent): string | null => {
  if (
    event.type !== "task-completed" &&
    event.type !== "task-failed" &&
    event.type !== "task-canceled"
  ) {
    return null;
  }

  const lines =
    event.type === "task-completed"
      ? ["[Task completed]"]
      : event.type === "task-canceled"
        ? ["[Task canceled]"]
        : ["[Task failed]"];

  if (event.taskId) lines.push(`task_id: ${event.taskId}`);
  if (event.agentType) lines.push(`agent_type: ${event.agentType}`);
  if (event.description) lines.push(`description: ${event.description}`);
  if (event.type === "task-completed" && event.result) {
    lines.push(`result: ${event.result}`);
  }
  if ((event.type === "task-failed" || event.type === "task-canceled") && event.error) {
    lines.push(`error: ${event.error}`);
  }

  return lines.join("\n");
};

export const createStellaHostRunner = ({
  deviceId,
  StellaHome,
  frontendRoot,
  stellaBrowserBinPath,
  stellaUiCliPath,
  selfModMonitor,
  selfModHmrController,
  getHmrMorphOrchestrator,
  requestCredential,
  scheduleApi,
  displayHtml,
  runtimeStore,
  listLocalChatEvents,
}: StellaHostRunnerOptions) => {
  const convexApi = anyApi;

  const envProxyBaseUrl = sanitizeStellaBase(process.env.STELLA_LLM_PROXY_URL ?? null);
  const envAuthToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;
  const envConvexDeploymentUrl = sanitizeConvexDeploymentUrl(process.env.STELLA_CONVEX_URL ?? null);

  let proxyBaseUrl: string | null = envProxyBaseUrl;
  let authToken: string | null = envAuthToken;
  let convexDeploymentUrl: string | null = envConvexDeploymentUrl;
  let convexClient: ConvexClient | null = null;
  let convexClientUrl: string | null = null;
  let cloudSyncEnabled = false;
  let isRunning = false;
  let isInitialized = false;
  let initializationPromise: Promise<void> | null = null;

  let localTaskManager: LocalTaskManager | null = null;
  let activeOrchestratorRunId: string | null = null;
  let activeOrchestratorConversationId: string | null = null;
  let activeSearchHtmlPrompts: SearchHtmlPromptConfig | undefined;
  const queuedOrchestratorTurns: QueuedOrchestratorTurn[] = [];
  const activeRunAbortControllers = new Map<string, AbortController>();
  const conversationCallbacks = new Map<string, AgentCallbacks>();
  const interruptedRunIds = new Set<string>();
  let activeToolExecutionCount = 0;
  let interruptAfterTool = false;
  let activeInterruptedReplayTurn: QueuedOrchestratorTurn | null = null;

  const skillsPath = path.join(StellaHome, "skills");
  const coreSkillsPath = path.join(StellaHome, "core-skills");
  const agentsPath = path.join(StellaHome, "agents");
  const extensionsPath = path.join(StellaHome, "extensions");
  const hookEmitter = new HookEmitter();

  let loadedAgents: ParsedAgentLike[] = [];
  let loadedSkills: ParsedSkill[] = [];
  let loadedSkillsPromise: Promise<ParsedSkill[]> | null = null;

  const refreshLoadedSkills = () => {
    const loadPromise = loadSkillsFromHome(skillsPath, coreSkillsPath)
      .then((skills) => {
        loadedSkills = skills;
        toolHost.setSkills(skills);
        return skills;
      })
      .catch(() => {
        loadedSkills = [];
        toolHost.setSkills([]);
        return [];
      });
    loadedSkillsPromise = loadPromise;
    return loadPromise;
  };

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
    stellaBrowserBinPath,
    stellaUiCliPath,
    requestCredential,
    displayHtml,
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
    const baseUrl = sanitizeStellaBase(proxyBaseUrl);
    const nextAuthToken = authToken?.trim();
    if (!baseUrl) {
      throw new Error("Stella runtime is missing proxy URL. Set STELLA_LLM_PROXY_URL or configure host URL.");
    }
    if (!nextAuthToken) {
      throw new Error("Stella runtime is missing auth token. Sign in or set STELLA_LLM_PROXY_TOKEN.");
    }
    return { baseUrl, authToken: nextAuthToken };
  };

  // WebSearch via backend Convex action (Exa API)
  const webSearch = async (
    query: string,
    options?: { category?: string; searchHtmlPrompts?: SearchHtmlPromptConfig },
  ): Promise<{ text: string; results: Array<{ title: string; url: string; snippet: string }>; html?: string }> => {
    try {
      const client = ensureConvexClient();
      if (!client) throw new Error("Not connected to Convex. Sign in or set STELLA_CONVEX_URL.");
      const searchHtmlPrompts = options?.searchHtmlPrompts ?? activeSearchHtmlPrompts;
      const result = await client.action(convexApi.agent.local_runtime.webSearch, {
        query,
        ...(options?.category ? { category: options.category } : {}),
        ...(searchHtmlPrompts
          ? {
              searchHtmlSystemPrompt: searchHtmlPrompts.systemPrompt,
              searchHtmlUserPromptTemplate: searchHtmlPrompts.userPromptTemplate,
            }
          : {}),
      }) as {
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
        html?: string;
      };
      if (result.html && displayHtml) {
        displayHtml(result.html);
      }
      return {
        ...result,
        text: result.html?.trim()
          ? result.html
          : result.text?.trim()
            ? result.text
            : "WebSearch returned no response.",
      };
    } catch (error) {
      return { text: `WebSearch failed: ${(error as Error).message}`, results: [] };
    }
  };


    // Fire and forget â€” don't block the agent
  const getConfiguredModel = (agentType: string, agent?: ParsedAgentLike | undefined): string | undefined => {
    const modelFromPrefs = getModelOverride(StellaHome, agentType);
    const defaultModel = getDefaultModel(StellaHome, agentType);
    return modelFromPrefs ?? defaultModel ?? agent?.model;
  };

  const buildAgentContext = async (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
  }): Promise<LocalTaskManagerAgentContext> => {
    const availableSkills = loadedSkillsPromise
      ? await loadedSkillsPromise
      : loadedSkills;
    const availableSkillIds = Array.from(new Set(availableSkills.map((skill) => skill.id)));
    const agent = resolveAgent(args.agentType);
    const model = getConfiguredModel(args.agentType, agent);
    const resolvedLlm = resolveLlmRoute({
      stellaHomePath: StellaHome,
      modelName: model,
      agentType: args.agentType,
      proxy: {
        baseUrl: proxyBaseUrl,
        getAuthToken: () => authToken?.trim(),
      },
    });
    const threadKey = buildRuntimeThreadKey({
      conversationId: args.conversationId,
      agentType: args.agentType,
      runId: args.runId,
      threadId: args.threadId,
    });
    const storedThreadMessages = runtimeStore.loadThreadMessages(threadKey);

    let threadHistory: Array<{ role: string; content: string; toolCallId?: string }> | undefined;
    if (args.agentType === "orchestrator" && listLocalChatEvents) {
      const localEvents = listLocalChatEvents(args.conversationId, 800).filter((event) =>
        LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
      const resolvedContextWindow = Number(resolvedLlm.model.contextWindow);
      const contextWindow = Number.isFinite(resolvedContextWindow) && resolvedContextWindow > 0
        ? Math.floor(resolvedContextWindow)
        : 128_000;
      const localHistoryBudget = Math.max(
        MIN_LOCAL_HISTORY_TOKENS,
        contextWindow - LOCAL_HISTORY_RESERVE_TOKENS,
      );
      const eventHistory = buildLocalHistoryFromEvents({
        events: localEvents,
        maxTokens: localHistoryBudget,
        warningThresholdTokens: Math.max(
          MIN_LOCAL_HISTORY_TOKENS,
          Math.floor(contextWindow * 0.85),
        ),
      });
      const checkpointMessage = storedThreadMessages.find((message) => {
        if (message.role !== "assistant") return false;
        return Boolean(parseThreadCheckpoint(message.content));
      });
      const checkpoint = checkpointMessage
        ? parseThreadCheckpoint(checkpointMessage.content)
        : null;
      threadHistory = [
        ...(checkpoint
          ? [{
              role: "assistant",
              content: checkpoint.previousThreadFile
                ? `${checkpoint.summary}\n\nPrevious thread file: ${checkpoint.previousThreadFile}`
                : checkpoint.summary,
            }]
          : []),
        ...eventHistory,
      ];
    } else {
      threadHistory = storedThreadMessages;
    }

    const activeThreadsPrompt =
      args.agentType === "orchestrator"
        ? buildActiveThreadsPrompt(runtimeStore.listActiveThreads(args.conversationId))
        : "";
    const dynamicContextSections = [
      args.agentType === "orchestrator" && frontendRoot
        ? buildPanelInventory(frontendRoot)
        : "",
      activeThreadsPrompt,
    ].filter((section) => section.trim().length > 0);
    const reminderState =
      args.agentType === "orchestrator" && activeThreadsPrompt
        ? runtimeStore.getOrchestratorReminderState(args.conversationId)
        : {
            shouldInjectDynamicReminder: false,
            reminderTokensSinceLastInjection: 0,
          };

    return {
      systemPrompt: agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
      dynamicContext: dynamicContextSections.join("\n\n"),
      orchestratorReminderText: activeThreadsPrompt || undefined,
      shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
      toolsAllowlist: agent?.toolsAllowlist,
      delegationAllowlist: agent?.delegationAllowlist,
      model,
      maxTaskDepth: agent?.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH,
      defaultSkills: (agent?.defaultSkills ?? []).filter((skillId) => availableSkillIds.includes(skillId)),
      skillIds: availableSkillIds,
      coreMemory: readCoreMemory(StellaHome),
      threadHistory: threadHistory.length > 0 ? threadHistory : undefined,
      activeThreadId: threadKey,
      agentEngine:
        args.agentType === "general"
          ? getGeneralAgentEngine(StellaHome)
          : args.agentType === "self_mod"
            ? getSelfModAgentEngine(StellaHome)
            : undefined,
      maxAgentConcurrency:
        args.agentType === "general" || args.agentType === "self_mod"
          ? getMaxAgentConcurrency(StellaHome)
          : undefined,
    };
  };

  const queueOrchestratorTurn = (
    turn: QueuedOrchestratorTurn,
  ) => {
    if (turn.priority === "user") {
      const firstSystemIndex = queuedOrchestratorTurns.findIndex(
        (entry) => entry.priority !== "user",
      );
      if (firstSystemIndex === -1) {
        queuedOrchestratorTurns.push(turn);
      } else {
        queuedOrchestratorTurns.splice(firstSystemIndex, 0, turn);
      }
    } else {
      queuedOrchestratorTurns.push(turn);
    }
    if (activeOrchestratorRunId) {
      requestActiveOrchestratorCheckpoint();
      return;
    }
    queueMicrotask(() => {
      void drainQueuedOrchestratorTurns();
    });
  };

  const clearActiveOrchestratorRun = (runId: string) => {
    if (activeOrchestratorRunId !== runId) {
      return;
    }
    activeOrchestratorRunId = null;
    activeOrchestratorConversationId = null;
    activeSearchHtmlPrompts = undefined;
    activeToolExecutionCount = 0;
    interruptAfterTool = false;
    activeInterruptedReplayTurn = null;
  };

  const abortActiveOrchestratorRunForQueuedTurn = () => {
    if (!activeOrchestratorRunId) {
      return false;
    }
    const runId = activeOrchestratorRunId;
    const abortController = activeRunAbortControllers.get(runId) ?? null;
    if (!abortController || interruptedRunIds.has(runId)) {
      return false;
    }
    interruptedRunIds.add(runId);
    abortController.abort(new Error(QUEUED_TURN_INTERRUPT_ERROR));
    return true;
  };

  const requestActiveOrchestratorCheckpoint = () => {
    if (!activeOrchestratorRunId) {
      return false;
    }
    if (activeToolExecutionCount > 0) {
      interruptAfterTool = true;
      return true;
    }
    interruptAfterTool = false;
    return abortActiveOrchestratorRunForQueuedTurn();
  };

  const maybeInterruptAfterToolCheckpoint = () => {
    if (!interruptAfterTool || activeToolExecutionCount > 0) {
      return;
    }
    interruptAfterTool = false;
    abortActiveOrchestratorRunForQueuedTurn();
  };

  const startStreamingOrchestratorTurn = async (
    payload: QueuedOrchestratorTurn,
    startArgs: {
      conversationId: string;
      userPrompt: string;
      agentType: string;
      userMessageId: string;
      searchHtmlPrompts?: SearchHtmlPromptConfig;
    },
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    if (activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running.");
    }

    const runId = `local:${crypto.randomUUID()}`;
    const conversationId = startArgs.conversationId;
    const agentType = startArgs.agentType;
    const userPrompt = startArgs.userPrompt.trim();
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

    activeOrchestratorRunId = runId;
    activeOrchestratorConversationId = conversationId;
    activeSearchHtmlPrompts = startArgs.searchHtmlPrompts;
    activeInterruptedReplayTurn = payload.requeueOnInterrupt ? payload : null;

    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    const cleanupRun = () => {
      activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
    };

    const runtimeCallbacks: RuntimeRunCallbacks = {
      onStream: callbacks.onStream,
      onToolStart: (event) => {
        activeToolExecutionCount += 1;
        callbacks.onToolStart(event);
      },
      onToolEnd: (event) => {
        activeToolExecutionCount = Math.max(0, activeToolExecutionCount - 1);
        callbacks.onToolEnd(event);
        if (activeOrchestratorRunId === runId) {
          maybeInterruptAfterToolCheckpoint();
        }
      },
      onError: (event) => {
        if (interruptedRunIds.delete(runId)) {
          const replayTurn = activeInterruptedReplayTurn;
          cleanupRun();
          if (replayTurn) {
            queueOrchestratorTurn(replayTurn);
          }
          return;
        }
        callbacks.onError(event);
        if (event.fatal) {
          cleanupRun();
        }
      },
      onEnd: (event) => {
        if (interruptedRunIds.delete(runId)) {
          const replayTurn = activeInterruptedReplayTurn;
          cleanupRun();
          if (replayTurn) {
            queueOrchestratorTurn(replayTurn);
          }
          return;
        }
        cleanupRun();
        callbacks.onEnd(event);
      },
    };

    void runOrchestratorTurn({
      runId,
      conversationId,
      userMessageId: startArgs.userMessageId,
      agentType,
      userPrompt,
      agentContext,
      callbacks: runtimeCallbacks,
      toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
      deviceId,
      stellaHome: StellaHome,
      resolvedLlm,
      store: runtimeStore,
      abortSignal: abortController.signal,
      frontendRoot,
      selfModMonitor,
      webSearch,
      hookEmitter,
      displayHtml,
    }).catch((error) => {
      if (interruptedRunIds.delete(runId)) {
        const replayTurn = activeInterruptedReplayTurn;
        cleanupRun();
        if (replayTurn) {
          queueOrchestratorTurn(replayTurn);
        }
        return;
      }
      cleanupRun();
      callbacks.onError({
        runId,
        agentType,
        seq: Date.now(),
        error: (error as Error).message || "Stella runtime failed",
        fatal: true,
      });
    });

    return { runId };
  };

  const drainQueuedOrchestratorTurns = async (): Promise<void> => {
    if (activeOrchestratorRunId) {
      return;
    }

    while (!activeOrchestratorRunId && queuedOrchestratorTurns.length > 0) {
      const nextTurn = queuedOrchestratorTurns.shift();
      if (!nextTurn) {
        return;
      }
      try {
        await nextTurn.execute();
      } catch {
        // Individual queued turn handlers are responsible for notifying callers.
      }
    }
  };

  localTaskManager = new LocalTaskManager({
    maxConcurrent: 24,
    getMaxConcurrent: () => getMaxAgentConcurrency(StellaHome),
    resolveTaskThread: ({ conversationId, agentType, threadName }) => {
      if (agentType !== "general" && agentType !== "self_mod") {
        return null;
      }
      return runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType,
        threadName,
      });
    },
    onTaskEvent: (event) => {
      conversationCallbacks.get(event.conversationId)?.onTaskEvent?.(event);
      const userPrompt = buildTaskEventPrompt(event);
      if (!userPrompt) {
        return;
      }
      const queuedTurn: QueuedOrchestratorTurn = {
        priority: "system",
        requeueOnInterrupt: true,
        execute: async () => {
          const callbacks = conversationCallbacks.get(event.conversationId);
          if (!callbacks) {
            return;
          }
          await startStreamingOrchestratorTurn(
            queuedTurn,
            {
              conversationId: event.conversationId,
              userPrompt,
              agentType: "orchestrator",
              userMessageId: `system:${crypto.randomUUID()}`,
            },
            callbacks,
          );
        },
      };
      queueOrchestratorTurn(queuedTurn);
    },
    fetchAgentContext: buildAgentContext,
    runSubagent: async ({
      conversationId,
      userMessageId,
      agentType,
      rootRunId,
      agentContext,
      taskDescription,
      taskPrompt,
      abortSignal,
      onProgress,
      toolExecutor,
    }) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const shouldControlHmr = agentType === "self_mod";
      const pauseApplied = shouldControlHmr && selfModHmrController
        ? await selfModHmrController.pause(runId)
        : true;

      if (shouldControlHmr && !pauseApplied) {
        console.warn("[self-mod-hmr] Pause endpoint unavailable for self_mod subagent.");
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
      const taskCallbacks = conversationCallbacks.get(conversationId) ?? null;
      const reportSelfModHmrState = (state: SelfModHmrState) => {
        taskCallbacks?.onSelfModHmrState?.(state);
      };
      if (shouldControlHmr && pauseApplied) {
        reportSelfModHmrState(createSelfModHmrState("paused", true));
      }
      try {
        return await runSubagentTask({
          conversationId,
          userMessageId,
          runId,
          rootRunId,
          agentType,
          userPrompt: `${taskDescription}\n\n${taskPrompt}`,
          agentContext,
          toolExecutor,
          deviceId,
          stellaHome: StellaHome,
          resolvedLlm,
          store: runtimeStore,
          abortSignal,
          frontendRoot,
          selfModMonitor,
          onProgress,
          callbacks: taskCallbacks ? {
            onStream: (ev) => taskCallbacks.onStream(ev),
            onToolStart: (ev) => taskCallbacks.onToolStart(ev),
            onToolEnd: (ev) => taskCallbacks.onToolEnd(ev),
            onError: (ev) => taskCallbacks.onError(ev),
            onEnd: (ev) => taskCallbacks.onEnd(ev),
          } : undefined,
          webSearch,
          hookEmitter,
        });
      } finally {
        if (shouldControlHmr && selfModHmrController) {
          const status = await selfModHmrController.getStatus().catch(() => null);
          const requiresFullReload = Boolean(status?.requiresFullReload);
          const shouldMorph = Boolean(
            status && (status.queuedFiles > 0 || status.requiresFullReload),
          );
          const resumeHmr = async () => {
            const resumeApplied = await selfModHmrController.resume(runId);
            if (!resumeApplied) {
              console.warn("[self-mod-hmr] Resume endpoint unavailable for self_mod subagent.");
            }
          };

          try {
            const morphOrchestrator = getHmrMorphOrchestrator?.() ?? null;
            if (shouldMorph && taskCallbacks?.onHmrResume) {
              await taskCallbacks.onHmrResume({
                resumeHmr,
                reportState: reportSelfModHmrState,
                requiresFullReload,
              });
            } else if (shouldMorph && morphOrchestrator) {
              await morphOrchestrator.runTransition({
                resumeHmr,
                reportState: reportSelfModHmrState,
                requiresFullReload,
              });
            } else {
              reportSelfModHmrState(
                createSelfModHmrState(
                  requiresFullReload ? "reloading" : "applying",
                  false,
                  requiresFullReload,
                ),
              );
              await resumeHmr();
              reportSelfModHmrState(createSelfModHmrState("idle", false));
            }
          } catch (error) {
            console.warn("[self-mod-hmr] Failed to resume self_mod subagent HMR:", (error as Error).message);
            await selfModHmrController.resume(runId).catch(() => undefined);
            reportSelfModHmrState(createSelfModHmrState("idle", false));
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
      proxyBaseUrl = sanitizeStellaBase(value);
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

  const initializeRuntime = () => {
    const skillsLoad = refreshLoadedSkills().then(() => undefined);
    const agentsLoad = loadAgentsFromHome(agentsPath)
      .then((agents) => {
        loadedAgents = agents;
      })
      .catch(() => {
        loadedAgents = [];
      });
    const extensionsLoad = loadExtensions(extensionsPath)
      .then((extensions) => {
        // Register extension hooks
        hookEmitter.registerAll(extensions.hooks);

        // Register extension tools on the tool host
        toolHost.registerExtensionTools(extensions.tools);

        // Register extension provider models in the model registry
        for (const providerDef of extensions.providers) {
          for (const modelDef of providerDef.models) {
            const model: Model<Api> = {
              id: modelDef.id,
              name: modelDef.name,
              api: providerDef.api as Api,
              provider: providerDef.name,
              baseUrl: providerDef.baseUrl,
              reasoning: modelDef.reasoning ?? false,
              input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
              cost: {
                input: modelDef.cost?.input ?? 0,
                output: modelDef.cost?.output ?? 0,
                cacheRead: modelDef.cost?.cacheRead ?? 0,
                cacheWrite: modelDef.cost?.cacheWrite ?? 0,
              },
              contextWindow: modelDef.contextWindow,
              maxTokens: modelDef.maxTokens,
              headers: providerDef.headers,
            };
            registerModel(providerDef.name, model);
          }
          console.log(`[stella:extensions] Registered provider "${providerDef.name}" with ${providerDef.models.length} model(s)`);
        }
        console.log(`[stella:extensions] Ready: ${extensions.tools.length} tools, ${extensions.hooks.length} hooks, ${extensions.providers.length} providers, ${extensions.prompts.length} prompts`);
      })
      .catch((error) => {
        console.error("[stella:extensions] Failed to load extensions:", (error as Error).message);
      });

    initializationPromise = Promise.all([
      skillsLoad,
      agentsLoad,
      extensionsLoad,
    ]).then(() => {
      isInitialized = true;
      syncRemoteTurnBridge();
    });

    return initializationPromise;
  };

  const start = () => {
    if (isRunning) return;
    isRunning = true;
    isInitialized = false;
    syncRemoteTurnBridge();
    void initializeRuntime();
  };

  const stop = () => {
    isRunning = false;
    isInitialized = false;
    initializationPromise = null;
    remoteTurnBridge.stop();
    disposeConvexClient();
    activeOrchestratorRunId = null;
    activeOrchestratorConversationId = null;
    activeSearchHtmlPrompts = undefined;
    activeToolExecutionCount = 0;
    interruptAfterTool = false;
    activeInterruptedReplayTurn = null;
    for (const controller of activeRunAbortControllers.values()) {
      controller.abort();
    }
    activeRunAbortControllers.clear();
    conversationCallbacks.clear();
    interruptedRunIds.clear();
    void selfModHmrController?.forceResumeAll();
    toolHost.killAllShells();
    shutdownSubagentRuntimes();
  };

  const agentHealthCheck = (): AgentHealth => {
    if (!isRunning) {
      return { ready: false, reason: "Stella runtime is not started", engine: "stella" };
    }
    if (!isInitialized) {
      return { ready: false, reason: "Stella runtime is still initializing", engine: "stella" };
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
    const hasProxyUrl = Boolean(sanitizeStellaBase(proxyBaseUrl));
    const hasAuthToken = Boolean(authToken?.trim());
    if (!hasProxyUrl) {
      return { ready: false, reason: "Missing proxy URL", engine: "pi" };
    }
    if (!hasAuthToken) {
      return { ready: false, reason: "Missing auth token", engine: "pi" };
    }
    return { ready: false, reason: "No usable model route", engine: "pi" };
  };

  const startLocalChatTurn = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
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

    console.log(`[stella:trace] handleLocalChat | runId=${runId} | agent=${agentType} | model=${agentContext.model} | resolvedModel=${resolvedLlm.model.id} | convId=${conversationId}`);
    console.log(`[stella:trace] handleLocalChat | tools=[${(agentContext.toolsAllowlist ?? []).join(", ")}]`);
    console.log(`[stella:trace] handleLocalChat | threadHistory=${agentContext.threadHistory?.length ?? 0} messages`);

    activeOrchestratorRunId = runId;
    activeOrchestratorConversationId = conversationId;
    activeSearchHtmlPrompts = payload.searchHtmlPrompts;

    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    const cleanupRun = () => {
      activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
    };

    const runtimeCallbacks: RuntimeRunCallbacks = {
      onStream: callbacks.onStream,
      onToolStart: (event) => {
        activeToolExecutionCount += 1;
        callbacks.onToolStart(event);
      },
      onToolEnd: (event) => {
        activeToolExecutionCount = Math.max(0, activeToolExecutionCount - 1);
        callbacks.onToolEnd(event);
        if (activeOrchestratorRunId === runId) {
          maybeInterruptAfterToolCheckpoint();
        }
      },
      onError: (event) => {
        if (interruptedRunIds.delete(runId)) {
          cleanupRun();
          return;
        }
        callbacks.onError(event);
        if (event.fatal) {
          cleanupRun();
        }
      },
      onEnd: (event) => {
        if (interruptedRunIds.delete(runId)) {
          cleanupRun();
          return;
        }
        cleanupRun();
        callbacks.onEnd(event);
      },
    };

    void runOrchestratorTurn({
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
      store: runtimeStore,
      abortSignal: abortController.signal,
      frontendRoot,
      selfModMonitor,
      webSearch,
      hookEmitter,
      displayHtml,
    }).catch((error) => {
      if (interruptedRunIds.delete(runId)) {
        cleanupRun();
        return;
      }
      cleanupRun();
      callbacks.onError({
        runId,
        agentType,
        seq: Date.now(),
        error: (error as Error).message || "Stella runtime failed",
        fatal: true,
      });
    });

    return { runId };
  };

  const handleLocalChat = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }

    conversationCallbacks.set(payload.conversationId, callbacks);

    const queuedTurn: QueuedOrchestratorTurn = {
      priority: "user",
      requeueOnInterrupt: false,
      execute: async () => {
        await startLocalChatTurn(payload, callbacks);
      },
    };

    if (activeOrchestratorRunId) {
      return await new Promise<{ runId: string }>((resolve, reject) => {
        queueOrchestratorTurn({
          ...queuedTurn,
          execute: async () => {
            try {
              resolve(await startLocalChatTurn(payload, callbacks));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        });
      });
    }

    return await startLocalChatTurn(payload, callbacks);
  };

  const startAutomationTurn = async (
    queuedTurn: QueuedOrchestratorTurn,
    payload: {
      conversationId: string;
      userPrompt: string;
      agentType?: string;
    },
    resolveResult: (value:
      | { status: "ok"; finalText: string }
      | { status: "busy"; finalText: ""; error: string }
      | { status: "error"; finalText: ""; error: string }
    ) => void,
  ): Promise<{ runId: string }> => {
    if (activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running.");
    }

    const conversationId = payload.conversationId.trim();
    const userPrompt = payload.userPrompt.trim();
    const agentType = payload.agentType ?? "orchestrator";
    if (!conversationId) {
      resolveResult({ status: "error", finalText: "", error: "Missing conversationId" });
      return { runId: "" };
    }
    if (!userPrompt) {
      resolveResult({ status: "error", finalText: "", error: "Missing user prompt" });
      return { runId: "" };
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
    activeSearchHtmlPrompts = undefined;
    activeInterruptedReplayTurn = queuedTurn.requeueOnInterrupt ? queuedTurn : null;

    const abortController = new AbortController();
    activeRunAbortControllers.set(runId, abortController);

    const cleanupRun = () => {
      activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
    };

    void runOrchestratorTurn({
      runId,
      conversationId,
      userMessageId: `automation:${crypto.randomUUID()}`,
      agentType,
      userPrompt,
      agentContext,
      callbacks: {
        onStream: () => {},
        onToolStart: () => {
          activeToolExecutionCount += 1;
        },
        onToolEnd: () => {
          activeToolExecutionCount = Math.max(0, activeToolExecutionCount - 1);
          if (activeOrchestratorRunId === runId) {
            maybeInterruptAfterToolCheckpoint();
          }
        },
        onError: (event) => {
          if (interruptedRunIds.delete(runId)) {
            const replayTurn = activeInterruptedReplayTurn;
            cleanupRun();
            if (replayTurn) {
              queueOrchestratorTurn(replayTurn);
            }
            return;
          }
          cleanupRun();
          resolveResult({
            status: "error",
            finalText: "",
            error: event.error || "Stella runtime failed",
          });
        },
        onEnd: (event) => {
          if (interruptedRunIds.delete(runId)) {
            const replayTurn = activeInterruptedReplayTurn;
            cleanupRun();
            if (replayTurn) {
              queueOrchestratorTurn(replayTurn);
            }
            return;
          }
          cleanupRun();
          resolveResult({
            status: "ok",
            finalText: event.finalText,
          });
        },
      },
      toolExecutor: (toolName, args, context) => toolHost.executeTool(toolName, args, context),
      deviceId,
      stellaHome: StellaHome,
      resolvedLlm,
      store: runtimeStore,
      abortSignal: abortController.signal,
      frontendRoot,
      selfModMonitor,
      webSearch,
      hookEmitter,
      displayHtml,
    }).catch((error) => {
      if (interruptedRunIds.delete(runId)) {
        const replayTurn = activeInterruptedReplayTurn;
        cleanupRun();
        if (replayTurn) {
          queueOrchestratorTurn(replayTurn);
        }
        return;
      }
      cleanupRun();
      resolveResult({
        status: "error",
        finalText: "",
        error: (error as Error).message || "Stella runtime failed",
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
        error: health.reason ?? "Stella runtime not ready",
      };
    }

    return await new Promise<
      | { status: "ok"; finalText: string }
      | { status: "busy"; finalText: ""; error: string }
      | { status: "error"; finalText: ""; error: string }
    >((resolve) => {
      const queuedTurn: QueuedOrchestratorTurn = {
        priority: "system",
        requeueOnInterrupt: true,
        execute: async () => {
          await startAutomationTurn(queuedTurn, payload, resolve);
        },
      };

      if (activeOrchestratorRunId) {
        queueOrchestratorTurn(queuedTurn);
        return;
      }

      void queuedTurn.execute();
    });
  };

  const remoteTurnBridge = createRemoteTurnBridge({
    deviceId,
    isEnabled: () => isRunning && cloudSyncEnabled,
    isRunnerBusy: () => false,
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
    if (!isRunning || !isInitialized || !cloudSyncEnabled) {
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
    clearActiveOrchestratorRun(runId);
  };

  const requestQueuedTurnCheckpoint = (conversationId?: string) => {
    if (
      conversationId &&
      activeOrchestratorConversationId &&
      activeOrchestratorConversationId !== conversationId
    ) {
      return false;
    }
    return requestActiveOrchestratorCheckpoint();
  };

  const getActiveOrchestratorRun = (): { runId: string; conversationId: string } | null => {
    if (
      !activeOrchestratorRunId ||
      !activeOrchestratorConversationId
    ) {
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
    hookEmitter,
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
    webSearch,
    handleLocalChat,
    runAutomationTurn,
    cancelLocalChat,
    requestQueuedTurnCheckpoint,
    getActiveOrchestratorRun,
    recoverCrashedRuns,
    appendThreadMessage: (args: {
      threadKey: string;
      role: "user" | "assistant";
      content: string;
    }) => {
      runtimeStore.appendThreadMessage({ ...args, timestamp: Date.now() });
    },
  };
};
