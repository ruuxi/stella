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
import {
  type LocalContextEvent,
  buildLocalHistoryFromEvents,
} from "../local-history.js";
import {
  formatDateTimeReminder,
  THIRTY_MINUTES_MS,
} from "../message-timestamp.js";
import {
  buildRuntimeThreadKey,
  parseThreadCheckpoint,
} from "../thread-runtime.js";
import {
  buildActiveThreadsPrompt,
  estimateRuntimeTokens,
} from "../runtime-threads.js";
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
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import { getBundledCoreAgentFallback } from "../agents/agents.js";
import {
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

type ThreadHistoryEntry = {
  timestamp?: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: PersistedRuntimeThreadPayload;
};

const getLocalHistoryBudget = (contextWindow: number): number =>
  Math.max(
    MIN_LOCAL_HISTORY_TOKENS,
    contextWindow - LOCAL_HISTORY_RESERVE_TOKENS,
  );

const getLocalHistoryWarningThreshold = (contextWindow: number): number =>
  Math.max(
    MIN_LOCAL_HISTORY_TOKENS,
    Math.floor(contextWindow * 0.85),
  );

const hasStoredCheckpoint = (messages: ThreadHistoryEntry[]): boolean =>
  messages.some(
    (message) =>
      message.role === "assistant" &&
      Boolean(parseThreadCheckpoint(message.content)),
  );

const getStoredMessagePreview = (
  message: ThreadHistoryEntry | undefined,
): string => message?.content.trim() ?? "";

const getLocalEventText = (event: LocalContextEvent): string => {
  if (!event.payload || typeof event.payload !== "object") {
    return "";
  }
  const payload = event.payload as Record<string, unknown>;
  const rawText =
    typeof payload.text === "string" && payload.text.trim()
      ? payload.text
      : typeof payload.contextText === "string"
        ? payload.contextText
        : "";
  return rawText.trim();
};

const getLocalEventTimezone = (
  event: LocalContextEvent | undefined,
): string | undefined => {
  if (!event?.payload || typeof event.payload !== "object") {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.timezone === "string" && payload.timezone.trim()
    ? payload.timezone.trim()
    : undefined;
};

const buildStaleUserReminder = (
  events: LocalContextEvent[],
): string | undefined => {
  const latestEvent = events[events.length - 1];
  if (!latestEvent || latestEvent.type !== "user_message") {
    return undefined;
  }
  const userEvents = events.filter((event) => event.type === "user_message");
  if (userEvents.length < 2) {
    return undefined;
  }
  const latestUserEvent = userEvents[userEvents.length - 1];
  const previousUserEvent = userEvents[userEvents.length - 2];
  if (!latestUserEvent || !previousUserEvent) {
    return undefined;
  }
  if (latestUserEvent.timestamp - previousUserEvent.timestamp < THIRTY_MINUTES_MS) {
    return undefined;
  }
  const timezone =
    getLocalEventTimezone(latestUserEvent) ??
    getLocalEventTimezone(previousUserEvent);
  return formatDateTimeReminder(latestUserEvent.timestamp, timezone);
};

const trimDuplicatedTransitionUserEvent = (
  events: LocalContextEvent[],
  storedThreadMessages: ThreadHistoryEntry[],
): LocalContextEvent[] => {
  const leadingStoredUserPreviews: string[] = [];
  for (const message of storedThreadMessages) {
    if (message.role !== "user") {
      break;
    }
    const preview = getStoredMessagePreview(message);
    if (!preview) {
      break;
    }
    leadingStoredUserPreviews.push(preview);
  }
  if (leadingStoredUserPreviews.length === 0 || events.length === 0) {
    return events;
  }
  const nextEvents = [...events];
  let storedIndex = leadingStoredUserPreviews.length - 1;
  let eventIndex = nextEvents.length - 1;
  let matchedCount = 0;

  while (storedIndex >= 0 && eventIndex >= 0) {
    const event = nextEvents[eventIndex];
    if (!event || event.type !== "user_message") {
      break;
    }
    if (getLocalEventText(event) !== leadingStoredUserPreviews[storedIndex]) {
      break;
    }
    matchedCount += 1;
    storedIndex -= 1;
    eventIndex -= 1;
  }

  if (matchedCount === 0) {
    return events;
  }
  nextEvents.splice(nextEvents.length - matchedCount, matchedCount);
  return nextEvents;
};

export const buildOrchestratorThreadHistory = (args: {
  storedThreadMessages: ThreadHistoryEntry[];
  localEvents?: LocalContextEvent[];
  contextWindow: number;
}): ThreadHistoryEntry[] => {
  const localEvents = args.localEvents ?? [];
  const localHistoryBudget = getLocalHistoryBudget(args.contextWindow);
  const warningThresholdTokens =
    getLocalHistoryWarningThreshold(args.contextWindow);

  if (args.storedThreadMessages.length === 0) {
    return buildLocalHistoryFromEvents({
      events: localEvents,
      maxTokens: localHistoryBudget,
      warningThresholdTokens,
    });
  }

  if (
    localEvents.length === 0 ||
    hasStoredCheckpoint(args.storedThreadMessages)
  ) {
    return args.storedThreadMessages;
  }

  const transitionCutoff =
    args.storedThreadMessages.find((message) => message.role !== "user")
      ?.timestamp ?? args.storedThreadMessages[0]?.timestamp;
  if (!transitionCutoff || !Number.isFinite(transitionCutoff)) {
    return args.storedThreadMessages;
  }

  const preTransitionEvents = trimDuplicatedTransitionUserEvent(
    localEvents.filter((event) => event.timestamp < transitionCutoff),
    args.storedThreadMessages,
  );
  if (preTransitionEvents.length === 0) {
    return args.storedThreadMessages;
  }

  const storedTokenEstimate = args.storedThreadMessages.reduce(
    (total, message) => total + estimateRuntimeTokens(message.content),
    0,
  );
  const preTransitionBudget = Math.max(
    MIN_LOCAL_HISTORY_TOKENS,
    localHistoryBudget - storedTokenEstimate,
  );

  const preTransitionHistory = buildLocalHistoryFromEvents({
    events: preTransitionEvents,
    maxTokens: preTransitionBudget,
    warningThresholdTokens,
  });

  if (preTransitionHistory.length === 0) {
    return args.storedThreadMessages;
  }

  return [...preTransitionHistory, ...args.storedThreadMessages];
};

export const createRunnerContext = ({
  deviceId,
  stellaHomePath,
  frontendRoot,
  stellaBrowserBinPath,
  stellaOfficeBinPath,
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
  appendLocalChatEvent,
  getDefaultConversationId,
}: StellaHostRunnerOptions): RunnerContext => {
  const envProxyBaseUrl = sanitizeStellaBase(
    process.env.STELLA_LLM_PROXY_URL ?? null,
  );
  const envAuthToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;
  const envConvexDeploymentUrl = sanitizeConvexDeploymentUrl(
    process.env.STELLA_CONVEX_URL ?? null,
  );

  const context = {} as RunnerContext;
  const hookEmitter = new HookEmitter();
  const toolHost = createToolHost({
    stellaHomePath,
    frontendRoot,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
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

  Object.assign(context, {
    convexApi: anyApi,
    deviceId,
    stellaHomePath,
    frontendRoot,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
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
    appendLocalChatEvent,
    getDefaultConversationId,
    paths: {
      skillsPath: path.join(stellaHomePath, "life", "knowledge"),
      extensionsPath: path.join(stellaHomePath, "runtime", "extensions"),
    },
    state: {
      convexSiteUrl: envProxyBaseUrl,
      authToken: envAuthToken,
      convexDeploymentUrl: envConvexDeploymentUrl,
      convexClient: null,
      convexClientUrl: null,
      hasConnectedAccount: false,
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
      googleWorkspaceToolNames: null,
      googleWorkspaceDisconnect: null,
      googleWorkspaceCallTool: null,
      googleWorkspaceAuthenticated: null,
    },
    ensureGoogleWorkspaceToolsLoaded: async () => undefined,
    hookEmitter,
    toolHost,
  });

  return context;
};

export const refreshLoadedSkills = (
  context: RunnerContext,
): Promise<ParsedSkill[]> => {
  const loadPromise = loadSkillsFromHome(context.paths.skillsPath)
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
    selfModMetadata?: {
      featureId?: string;
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update";
      displayName?: string;
      description?: string;
    };
  },
): Promise<LocalTaskManagerAgentContext> => {
  const availableSkills = context.state.loadedSkillsPromise
    ? await context.state.loadedSkillsPromise
    : context.state.loadedSkills;
  const availableSkillIds = Array.from(
    new Set(
      availableSkills
        .map((skill) => skill.id)
        .filter((id) => id !== "google-workspace"),
    ),
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

  const resolvedContextWindow = Number(resolvedLlm.model.contextWindow);
  const contextWindow =
    Number.isFinite(resolvedContextWindow) && resolvedContextWindow > 0
      ? Math.floor(resolvedContextWindow)
      : 128_000;

  let threadHistory: ThreadHistoryEntry[] | undefined;
  let staleUserReminderText: string | undefined;
  if (args.agentType === AGENT_IDS.ORCHESTRATOR && context.listLocalChatEvents) {
    const localEvents = context
      .listLocalChatEvents(args.conversationId, 800)
      .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
    staleUserReminderText = buildStaleUserReminder(localEvents);
    threadHistory = buildOrchestratorThreadHistory({
      storedThreadMessages,
      localEvents,
      contextWindow,
    });
  } else {
    threadHistory = storedThreadMessages;
  }

  const activeThreadsPrompt =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildActiveThreadsPrompt(
          context.runtimeStore.listActiveThreads(args.conversationId),
        )
      : "";
  const isSelfModTask = Boolean(args.selfModMetadata);

  const dynamicContextSections: string[] = [];
  const reminderState =
    args.agentType === AGENT_IDS.ORCHESTRATOR && activeThreadsPrompt
      ? context.runtimeStore.getOrchestratorReminderState(args.conversationId)
      : {
          shouldInjectDynamicReminder: false,
          reminderTokensSinceLastInjection: 0,
        };
  const enginePref = getAgentEnginePreference(args.agentType);

  const toolsAllowlist = agent?.toolsAllowlist;

  return {
    systemPrompt:
      agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
    dynamicContext: dynamicContextSections.join("\n\n"),
    orchestratorReminderText: activeThreadsPrompt || undefined,
    shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
    staleUserReminderText,
    toolsAllowlist,
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
      isSelfModTask
        ? getSelfModAgentEngine(context.stellaHomePath)
        : enginePref === "general"
        ? getGeneralAgentEngine(context.stellaHomePath)
        : undefined,
    maxAgentConcurrency: isLocalCliAgentId(args.agentType)
      ? getMaxAgentConcurrency(context.stellaHomePath)
      : undefined,
  };
};
