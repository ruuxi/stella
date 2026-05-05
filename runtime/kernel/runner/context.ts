import path from "path";
import { createFashionApi } from "./fashion-api.js";
import { createToolHost } from "../tools/host.js";
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
import { ConvexClient } from "convex/browser";
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
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { renderSkillCatalogBlock } from "../shared/skill-catalog.js";
import { listStellaConnectors } from "../mcp/state.js";
import type {
  RunnerContext,
  ParsedAgentLike,
  StellaHostRunnerOptions,
} from "./types.js";
import {
  AGENT_IDS,
  getAgentEnginePreference,
  isLocalCliAgentId,
} from "../../contracts/agent-runtime.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import { getBundledCoreAgentFallback } from "../agents/agents.js";
import {
  defaultPromptForAgentType,
  DEFAULT_MAX_AGENT_DEPTH,
  LOCAL_CONTEXT_EVENT_TYPES,
  LOCAL_HISTORY_RESERVE_TOKENS,
  MIN_LOCAL_HISTORY_TOKENS,
  readCoreMemory,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
} from "./shared.js";
import { resolveRunnerLlmRouteWithMetadata } from "./model-selection.js";
import { getResponseLanguageSystemPrompt } from "./locale-prompt.js";
import {
  getFileEditToolFamily,
  rewriteFileEditToolNames,
} from "../tools/file-edit-policy.js";

type ThreadHistoryEntry = {
  timestamp?: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: PersistedRuntimeThreadPayload;
  customMessage?: RuntimeThreadMessage["customMessage"];
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

/**
 * Picks the user's preferred locale off the most recent `user_message`
 * event payload. Locale is plumbed in alongside `timezone` from the
 * desktop chat send path; the runtime never reads it from local
 * preferences directly.
 */
const getLocalEventLocale = (
  event: LocalContextEvent | undefined,
): string | undefined => {
  if (!event?.payload || typeof event.payload !== "object") {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.locale === "string" && payload.locale.trim()
    ? payload.locale.trim()
    : undefined;
};

const findLatestLocale = (events: LocalContextEvent[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "user_message") continue;
    const locale = getLocalEventLocale(event);
    if (locale) return locale;
  }
  return undefined;
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
  stellaRoot,
  stellaBrowserBinPath,
  stellaOfficeBinPath,
  stellaUiCliPath,
  stellaComputerCliPath,
  selfModMonitor,
  selfModLifecycle,
  selfModHmrController,
  requestCredential,
  requestRuntimeAuthRefresh,
  notifyVoiceActionComplete,
  scheduleApi,
  
  fashionApi,
  displayHtml,
  runtimeStore,
  listLocalChatEvents,
  appendLocalChatEvent,
  getDefaultConversationId,
  memoryStore,
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

  const convexAction = async (ref: unknown, args: unknown): Promise<unknown> => {
    const deploymentUrl = sanitizeConvexDeploymentUrl(
      context.state?.convexDeploymentUrl ?? envConvexDeploymentUrl,
    );
    const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
    if (!deploymentUrl || !authToken) {
      throw new Error("Convex connection and auth are required.");
    }

    const existingClient = context.state?.convexClient;
    if (existingClient && context.state?.convexClientUrl === deploymentUrl) {
      return await (existingClient as { action: (tool: unknown, params: unknown) => Promise<unknown> }).action(
        ref,
        args,
      );
    }

    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => authToken);
    try {
      return await (client as { action: (tool: unknown, params: unknown) => Promise<unknown> }).action(
        ref,
        args,
      );
    } finally {
      void client.close().catch(() => undefined);
    }
  };

  const resolvedFashionApi =
    fashionApi ?? createFashionApi({ convexAction, convexApi: anyApi });

  const toolHost = createToolHost({
    stellaRoot,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaUiCliPath,
    stellaComputerCliPath,
    requestCredential,
    notifyVoiceActionComplete,
    displayHtml,
    scheduleApi,
    
    fashionApi: resolvedFashionApi,
    webSearch: async (query, searchOptions) => {
      const handler = context.state?.webSearch;
      if (!handler) {
        return {
          text: "Web search is not available yet — runtime is still starting up.",
          results: [],
        };
      }
      return await handler(query, searchOptions);
    },
    getStellaSiteAuth: () => {
      const baseUrl = sanitizeStellaBase(context.state?.convexSiteUrl ?? envProxyBaseUrl);
      const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
    queryConvex: async (ref, args) => {
      const deploymentUrl = sanitizeConvexDeploymentUrl(
        context.state?.convexDeploymentUrl ?? envConvexDeploymentUrl,
      );
      const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
      if (!deploymentUrl || !authToken) {
        throw new Error("Convex connection and auth are required.");
      }

      const existingClient = context.state?.convexClient;
      if (existingClient && context.state?.convexClientUrl === deploymentUrl) {
        return await (existingClient as { query: (tool: unknown, params: unknown) => Promise<unknown> }).query(
          ref,
          args,
        );
      }

      const client = new ConvexClient(deploymentUrl, {
        logger: false,
        unsavedChangesWarning: false,
      });
      client.setAuth(async () => authToken);
      try {
        return await (client as { query: (tool: unknown, params: unknown) => Promise<unknown> }).query(
          ref,
          args,
        );
      } finally {
        void client.close().catch(() => undefined);
      }
    },
    ...(memoryStore ?? runtimeStore?.memoryStore
      ? { memoryStore: memoryStore ?? runtimeStore.memoryStore }
      : {}),
    ...(runtimeStore?.threadSummariesStore
      ? { threadSummariesStore: runtimeStore.threadSummariesStore }
      : {}),
    stellaHome: stellaRoot,
    agentApi: {
      createAgent: async (request) => {
        if (!context.state.localAgentManager) {
          throw new Error("Local task manager not initialized");
        }
        return await context.state.localAgentManager.createAgent(request);
      },
      getAgent: async (agentId) => {
        if (!context.state.localAgentManager) {
          return null;
        }
        return await context.state.localAgentManager.getAgent(agentId);
      },
      cancelAgent: async (agentId, reason) => {
        if (!context.state.localAgentManager) {
          return { canceled: false };
        }
        return await context.state.localAgentManager.cancelAgent(agentId, reason);
      },
      sendAgentMessage: async (agentId, message, from, options) => {
        if (
          !context.state.localAgentManager ||
          typeof context.state.localAgentManager.sendAgentMessage !== "function"
        ) {
          return { delivered: false };
        }
        return await context.state.localAgentManager.sendAgentMessage(
          agentId,
          message,
          from,
          options,
        );
      },
      drainAgentMessages: async (agentId, recipient) => {
        if (
          !context.state.localAgentManager ||
          typeof context.state.localAgentManager.drainAgentMessages !== "function"
        ) {
          return [];
        }
        return await context.state.localAgentManager.drainAgentMessages(
          agentId,
          recipient,
        );
      },
    },
  });

  Object.assign(context, {
    convexApi: anyApi,
    deviceId,
    stellaRoot,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaUiCliPath,
    stellaComputerCliPath,
    selfModMonitor,
    selfModLifecycle,
    selfModHmrController,
    requestCredential,
    requestRuntimeAuthRefresh,
    notifyVoiceActionComplete,
    scheduleApi,
    
    fashionApi: resolvedFashionApi,
    displayHtml,
    runtimeStore,
    listLocalChatEvents,
    appendLocalChatEvent,
    getDefaultConversationId,
    paths: {
      extensionsPath: path.join(stellaRoot, "runtime", "extensions"),
    },
    state: {
      convexSiteUrl: envProxyBaseUrl,
      authToken: envAuthToken,
      convexDeploymentUrl: envConvexDeploymentUrl,
      convexClient: null,
      convexClientUrl: null,
      hasConnectedAccount: false,
      cloudSyncEnabled: false,
      modelCatalogUpdatedAt: null,
      isRunning: false,
      isInitialized: false,
      initializationPromise: null,
      localAgentManager: null,
      activeOrchestratorRunId: null,
      activeOrchestratorConversationId: null,
      activeOrchestratorUiVisibility: "visible",
      activeOrchestratorSession: null,
      queuedOrchestratorTurns: [],
      activeRunAbortControllers: new Map(),
      conversationCallbacks: new Map(),
      runCallbacksByRunId: new Map(),
      interruptedRunIds: new Set(),
      activeToolExecutionCount: 0,
      interruptAfterTool: false,
      activeInterruptedReplayTurn: null,
      loadedAgents: [],
      googleWorkspaceToolsLoaded: false,
      googleWorkspaceDisconnect: null,
      googleWorkspaceCallTool: null,
      googleWorkspaceAuthenticated: null,
      webSearch: null,
    },
    ensureGoogleWorkspaceToolsLoaded: async () => undefined,
    hookEmitter,
    toolHost,
  });

  return context;
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
  const modelFromPrefs = getModelOverride(context.stellaRoot, agentType);
  const defaultModel = getDefaultModel(context.stellaRoot, agentType);
  return modelFromPrefs ?? defaultModel ?? agent?.model;
};

export const buildAgentContext = async (
  context: RunnerContext,
  args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
    toolWorkspaceRoot?: string;
    selfModMetadata?: {
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update" | "uninstall";
    };
    /**
     * True only on Orchestrator turns that should re-inject the dynamic
     * memory bundle. Computed by prepareOrchestratorRun on the every-N-turn
     * cadence; subagent paths leave this undefined and never see memory.
     */
    shouldInjectDynamicMemory?: boolean;
  },
): Promise<LocalAgentContext> => {
  const agent = resolveAgent(context, args.agentType);
  const model = getConfiguredModel(context, args.agentType, agent);
  const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
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
  // Locale is plumbed onto user-message payloads alongside `timezone`, so
  // we read whatever was most recently sent. The orchestrator path
  // already loads recent local events to build history; subagent paths
  // make a fresh, smaller fetch since they don't otherwise need the
  // local-events stream.
  let userLocale: string | undefined;
  if (args.agentType === AGENT_IDS.ORCHESTRATOR && context.listLocalChatEvents) {
    const localEvents = context
      .listLocalChatEvents(args.conversationId, 800)
      .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
    staleUserReminderText = buildStaleUserReminder(localEvents);
    userLocale = findLatestLocale(localEvents);
    threadHistory = buildOrchestratorThreadHistory({
      storedThreadMessages,
      localEvents,
      contextWindow,
    });
  } else {
    threadHistory = storedThreadMessages;
    if (context.listLocalChatEvents) {
      const recent = context
        .listLocalChatEvents(args.conversationId, 32)
        .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
      userLocale = findLatestLocale(recent);
    }
  }

  const activeThreadsPrompt =
    args.agentType === AGENT_IDS.ORCHESTRATOR
      ? buildActiveThreadsPrompt(
          context.runtimeStore.listActiveThreads(args.conversationId),
        )
      : "";
  const isSelfModTask = Boolean(args.selfModMetadata);

  const dynamicContextSections: string[] = [];

  // Inject the user's response-language directive at the top of the
  // dynamic context. It's a single line, comes from the latest
  // `user_message` event's `locale` payload, and is `undefined` for
  // English so we don't waste tokens on a no-op directive.
  const responseLanguageDirective =
    getResponseLanguageSystemPrompt(userLocale);
  if (responseLanguageDirective) {
    dynamicContextSections.push(
      `## User Language\n${responseLanguageDirective}`,
    );
  }

  if (args.toolWorkspaceRoot?.trim()) {
    dynamicContextSections.push(
      [
        "## Shared Session Workspace",
        `Workspace root: ${args.toolWorkspaceRoot.trim()}`,
        "Use relative paths unless an absolute path under this workspace is already shown by a tool.",
        "File tools are restricted to this workspace root.",
      ].join("\n"),
    );
  }
  const reminderState =
    args.agentType === AGENT_IDS.ORCHESTRATOR && activeThreadsPrompt
      ? context.runtimeStore.getOrchestratorReminderState(args.conversationId)
      : {
          shouldInjectDynamicReminder: false,
          reminderTokensSinceLastInjection: 0,
        };
  const enginePref = getAgentEnginePreference(args.agentType);

  const fileEditToolFamily = getFileEditToolFamily({
    agentType: args.agentType,
    model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
  });
  const toolsAllowlist = rewriteFileEditToolNames(
    agent?.toolsAllowlist,
    fileEditToolFamily,
  );
  if (
    args.agentType !== AGENT_IDS.ORCHESTRATOR &&
    fileEditToolFamily === "write_edit"
  ) {
    dynamicContextSections.push(
      [
        "## File Editing Tools",
        "This run is using a non-OpenAI model. Use `Write` for new or full-file edits and `Edit` for targeted replacements.",
        "`apply_patch` is not available in this run.",
      ].join("\n"),
    );
  }
  if (
    args.agentType === AGENT_IDS.ORCHESTRATOR ||
    args.agentType === AGENT_IDS.GENERAL
  ) {
    dynamicContextSections.push(await renderSkillCatalogBlock(context.stellaRoot));
  }
  if (args.agentType === AGENT_IDS.GENERAL) {
    const connectors = await listStellaConnectors(context.stellaRoot);
    const installed = connectors.filter((connector) => connector.installed);
    const available = connectors.filter(
      (connector) => !connector.installed && connector.status === "official-mcp",
    );
    const lines = [
      "## Stella Connect",
      "Connected-service tools are discovered on demand through the `MCP` tool; full tool schemas are not preloaded.",
      installed.length > 0
        ? `Installed: ${installed.map((entry) => entry.displayName).join(", ")}.`
        : "Installed: none.",
      available.length > 0
        ? `Ready to add: ${available.map((entry) => entry.displayName).join(", ")}.`
        : "",
    ].filter(Boolean);
    dynamicContextSections.push(lines.join("\n"));
  }

  // Memory snapshot is only built for Orchestrator turns that the caller
  // marked as "inject this turn" — every Nth user turn. Skipping the work
  // on coast turns keeps both the prompt and the snapshot rebuild cheap.
  let memorySnapshot: { memory?: string; user?: string } | undefined;
  const shouldInjectDynamicMemory =
    args.agentType === AGENT_IDS.ORCHESTRATOR
    && args.shouldInjectDynamicMemory === true;
  if (shouldInjectDynamicMemory) {
    const memoryStore = context.runtimeStore.memoryStore;
    // Freeze a fresh snapshot for this run so new writes appear on the next
    // turn without changing the current run's prefix.
    memoryStore.loadSnapshot();
    const memoryBlock = memoryStore.formatForSystemPrompt("memory");
    const userBlock = memoryStore.formatForSystemPrompt("user");
    if (memoryBlock || userBlock) {
      memorySnapshot = {
        ...(memoryBlock ? { memory: memoryBlock } : {}),
        ...(userBlock ? { user: userBlock } : {}),
      };
    }
  }

  return {
    systemPrompt:
      agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
    dynamicContext: dynamicContextSections.join("\n\n"),
    orchestratorReminderText: activeThreadsPrompt || undefined,
    shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
    staleUserReminderText,
    toolsAllowlist,
    model,
    maxAgentDepth: agent?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH,
    coreMemory: readCoreMemory(context.stellaRoot),
    ...(memorySnapshot ? { memorySnapshot } : {}),
    ...(shouldInjectDynamicMemory ? { shouldInjectDynamicMemory: true } : {}),
    threadHistory: threadHistory.length > 0 ? threadHistory : undefined,
    activeThreadId: threadKey,
    agentEngine:
      isSelfModTask
        ? getSelfModAgentEngine(context.stellaRoot)
        : enginePref === "general"
        ? getGeneralAgentEngine(context.stellaRoot)
        : undefined,
    maxAgentConcurrency: isLocalCliAgentId(args.agentType)
      ? getMaxAgentConcurrency(context.stellaRoot)
      : undefined,
  };
};
