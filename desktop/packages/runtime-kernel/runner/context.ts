import path from "path";
import { createToolHost } from "../tools/host.js";
import { loadSkillsFromHome } from "../agents/skills.js";
import { HookEmitter } from "../extensions/hook-emitter.js";
import {
  getDefaultModel,
  getGeneralAgentEngine,
  getMaxAgentConcurrency,
  getModelOverride,
  getSelfModAgentEngine,
} from "../preferences/local-preferences.js";
import { buildLocalHistoryFromEvents } from "../local-history.js";
import {
  buildRuntimeThreadKey,
  parseThreadCheckpoint,
} from "../thread-runtime.js";
import { buildActiveThreadsPrompt } from "../runtime-threads.js";
import { anyApi } from "convex/server";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type { ParsedSkill } from "../agents/manifests.js";
import type {
  RunnerContext,
  ParsedAgentLike,
  StellaHostRunnerOptions,
} from "./types.js";
import {
  AGENT_IDS,
  getAgentEnginePreference,
  isLocalCliAgentId,
} from "../../../src/shared/contracts/agent-runtime.js";
import { getBundledCoreAgentFallback } from "../agents/agents.js";
import {
  buildManagedMediaDocsPrompt,
  buildPanelInventory,
  defaultPromptForAgentType,
  DEFAULT_MAX_TASK_DEPTH,
  LOCAL_CONTEXT_EVENT_TYPES,
  LOCAL_HISTORY_RESERVE_TOKENS,
  MIN_LOCAL_HISTORY_TOKENS,
  readCoreMemory,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
} from "./shared.js";
import { resolveRunnerLlmRoute } from "./model-selection.js";

export const createRunnerContext = ({
  deviceId,
  stellaHomePath,
  frontendRoot,
  stellaBrowserBinPath,
  stellaUiCliPath,
  selfModMonitor,
  selfModLifecycle,
  selfModHmrController,
  getHmrTransitionController,
  signHeartbeatPayload,
  requestCredential,
  scheduleApi,
  displayHtml,
  runtimeStore,
  listLocalChatEvents,
}: StellaHostRunnerOptions): RunnerContext => {
  const envProxyBaseUrl = sanitizeStellaBase(
    process.env.STELLA_LLM_PROXY_URL ?? null,
  );
  const envAuthToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;
  const envConvexDeploymentUrl = sanitizeConvexDeploymentUrl(
    process.env.STELLA_CONVEX_URL ?? null,
  );

  let context!: RunnerContext;
  const hookEmitter = new HookEmitter();
  const toolHost = createToolHost({
    stellaHomePath,
    frontendRoot,
    stellaBrowserBinPath,
    stellaUiCliPath,
    requestCredential,
    displayHtml,
    scheduleApi,
    taskApi: {
      createTask: async (request) => {
        if (!context.state.localTaskManager) {
          throw new Error("Local task manager not initialized");
        }
        return await context.state.localTaskManager.createTask(request);
      },
      getTask: async (taskId) => {
        if (!context.state.localTaskManager) {
          return null;
        }
        return await context.state.localTaskManager.getTask(taskId);
      },
      cancelTask: async (taskId, reason) => {
        if (!context.state.localTaskManager) {
          return { canceled: false };
        }
        return await context.state.localTaskManager.cancelTask(taskId, reason);
      },
      sendTaskMessage: async (taskId, message, from) => {
        if (
          !context.state.localTaskManager ||
          typeof context.state.localTaskManager.sendTaskMessage !== "function"
        ) {
          return { delivered: false };
        }
        return await context.state.localTaskManager.sendTaskMessage(
          taskId,
          message,
          from,
        );
      },
      drainTaskMessages: async (taskId, recipient) => {
        if (
          !context.state.localTaskManager ||
          typeof context.state.localTaskManager.drainTaskMessages !== "function"
        ) {
          return [];
        }
        return await context.state.localTaskManager.drainTaskMessages(
          taskId,
          recipient,
        );
      },
    },
  });

  context = {
    convexApi: anyApi,
    deviceId,
    stellaHomePath,
    frontendRoot,
    stellaBrowserBinPath,
    stellaUiCliPath,
    selfModMonitor,
    selfModLifecycle,
    selfModHmrController,
    getHmrTransitionController,
    signHeartbeatPayload,
    requestCredential,
    scheduleApi,
    displayHtml,
    runtimeStore,
    listLocalChatEvents,
    paths: {
      skillsPath: path.join(stellaHomePath, "skills"),
      coreSkillsPath: path.join(stellaHomePath, "core-skills"),
      agentsPath: path.join(stellaHomePath, "agents"),
      extensionsPath: path.join(stellaHomePath, "extensions"),
    },
    state: {
      proxyBaseUrl: envProxyBaseUrl,
      authToken: envAuthToken,
      convexDeploymentUrl: envConvexDeploymentUrl,
      convexClient: null,
      convexClientUrl: null,
      cloudSyncEnabled: false,
      isRunning: false,
      isInitialized: false,
      initializationPromise: null,
      localTaskManager: null,
      activeOrchestratorRunId: null,
      activeOrchestratorConversationId: null,
      queuedOrchestratorTurns: [],
      activeRunAbortControllers: new Map(),
      conversationCallbacks: new Map(),
      interruptedRunIds: new Set(),
      activeToolExecutionCount: 0,
      interruptAfterTool: false,
      activeInterruptedReplayTurn: null,
      loadedAgents: [],
      loadedSkills: [],
      loadedSkillsPromise: null,
    },
    hookEmitter,
    toolHost,
  };

  return context;
};

export const refreshLoadedSkills = (
  context: RunnerContext,
): Promise<ParsedSkill[]> => {
  const loadPromise = loadSkillsFromHome(
    context.paths.skillsPath,
    context.paths.coreSkillsPath,
  )
    .then((skills) => {
      context.state.loadedSkills = skills;
      context.toolHost.setSkills(skills);
      return skills;
    })
    .catch(() => {
      context.state.loadedSkills = [];
      context.toolHost.setSkills([]);
      return [];
    });
  context.state.loadedSkillsPromise = loadPromise;
  return loadPromise;
};

export const resolveAgent = (
  context: RunnerContext,
  agentType: string,
): ParsedAgentLike | undefined =>
  context.state.loadedAgents.find((entry) =>
    entry.agentTypes.includes(agentType),
  ) ??
  context.state.loadedAgents.find((entry) => entry.id === agentType) ??
  getBundledCoreAgentFallback(agentType);

export const getConfiguredModel = (
  context: RunnerContext,
  agentType: string,
  agent?: ParsedAgentLike,
): string | undefined => {
  const modelFromPrefs = getModelOverride(context.stellaHomePath, agentType);
  const defaultModel = getDefaultModel(context.stellaHomePath, agentType);
  return modelFromPrefs ?? defaultModel ?? agent?.model;
};

export const buildAgentContext = async (
  context: RunnerContext,
  args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
  },
): Promise<LocalTaskManagerAgentContext> => {
  const availableSkills = context.state.loadedSkillsPromise
    ? await context.state.loadedSkillsPromise
    : context.state.loadedSkills;
  const availableSkillIds = Array.from(
    new Set(availableSkills.map((skill) => skill.id)),
  );
  const agent = resolveAgent(context, args.agentType);
  const model = getConfiguredModel(context, args.agentType, agent);
  const resolvedLlm = resolveRunnerLlmRoute(
    context,
    args.agentType,
    model,
  );
  const threadKey = buildRuntimeThreadKey({
    conversationId: args.conversationId,
    agentType: args.agentType,
    runId: args.runId,
    threadId: args.threadId,
  });
  const storedThreadMessages =
    context.runtimeStore.loadThreadMessages(threadKey);

  let threadHistory:
    | Array<{ role: string; content: string; toolCallId?: string }>
    | undefined;
  if (
    args.agentType === AGENT_IDS.ORCHESTRATOR &&
    context.listLocalChatEvents
  ) {
    const localEvents = context
      .listLocalChatEvents(args.conversationId, 800)
      .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
    const resolvedContextWindow = Number(resolvedLlm.model.contextWindow);
    const contextWindow =
      Number.isFinite(resolvedContextWindow) && resolvedContextWindow > 0
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
        ? [
            {
              role: "assistant",
              content: checkpoint.previousThreadFile
                ? `${checkpoint.summary}\n\nPrevious thread file: ${checkpoint.previousThreadFile}`
                : checkpoint.summary,
            },
          ]
        : []),
      ...eventHistory,
    ];
  } else {
    threadHistory = storedThreadMessages;
  }

  const activeThreadsPrompt =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildActiveThreadsPrompt(
          context.runtimeStore.listActiveThreads(args.conversationId),
        )
      : "";
  const dynamicContextSections = [
    args.agentType === AGENT_IDS.ORCHESTRATOR && context.frontendRoot
      ? buildPanelInventory(context.frontendRoot)
      : "",
    args.agentType === AGENT_IDS.SELF_MOD ||
    args.agentType === AGENT_IDS.DASHBOARD_GENERATION
      ? buildManagedMediaDocsPrompt(context.state.convexDeploymentUrl)
      : "",
    activeThreadsPrompt,
  ].filter((section) => section.trim().length > 0);
  const reminderState =
    args.agentType === AGENT_IDS.ORCHESTRATOR && activeThreadsPrompt
      ? context.runtimeStore.getOrchestratorReminderState(args.conversationId)
      : {
          shouldInjectDynamicReminder: false,
          reminderTokensSinceLastInjection: 0,
        };
  const enginePref = getAgentEnginePreference(args.agentType);

  return {
    systemPrompt:
      agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
    dynamicContext: dynamicContextSections.join("\n\n"),
    orchestratorReminderText: activeThreadsPrompt || undefined,
    shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
    toolsAllowlist: agent?.toolsAllowlist,
    delegationAllowlist: agent?.delegationAllowlist,
    model,
    maxTaskDepth: agent?.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH,
    defaultSkills: (agent?.defaultSkills ?? []).filter((skillId) =>
      availableSkillIds.includes(skillId),
    ),
    skillIds: availableSkillIds,
    coreMemory: readCoreMemory(context.stellaHomePath),
    threadHistory: threadHistory.length > 0 ? threadHistory : undefined,
    activeThreadId: threadKey,
    agentEngine:
      enginePref === "general"
        ? getGeneralAgentEngine(context.stellaHomePath)
        : enginePref === "self_mod" ||
            args.agentType === AGENT_IDS.DASHBOARD_GENERATION
          ? getSelfModAgentEngine(context.stellaHomePath)
          : undefined,
    maxAgentConcurrency: isLocalCliAgentId(args.agentType)
      ? getMaxAgentConcurrency(context.stellaHomePath)
      : undefined,
  };
};
