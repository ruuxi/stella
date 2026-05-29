import path from "path";
import { createFashionApi } from "./fashion-api.js";
import { createToolHost } from "../tools/host.js";
import { HookEmitter } from "../extensions/hook-emitter.js";
import {
  getAgentRuntimeEngine,
  getMaxAgentConcurrency,
  getModelOverride,
  getReasoningEffort,
} from "../preferences/local-preferences.js";
import { isCursorModelOverride } from "../../contracts/agent-engine.js";
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
import type {
  RunnerContext,
  ParsedAgentLike,
  StellaHostRunnerOptions,
} from "./types.js";
import {
  AGENT_IDS,
  agentHasCapability,
  isLocalCliAgentId,
} from "../../contracts/agent-runtime.js";
import {
  collectSubagentRoster,
  renderSubagentRosterBlock,
} from "./subagent-roster.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import { getBundledCoreAgentFallback } from "../agents/agents.js";
import { BackgroundCompactionScheduler } from "../agent-runtime/compaction-scheduler.js";
import { runContextLookup } from "../agent-runtime/context-lookup.js";
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

const CODEX_SKILL_CATALOG_OMITTED_IDS = [
  "stella-computer-windows",
  "stella-computer-macos",
  "stella-browser",
  "electron",
  "stella-office",
  "stella-runtime-extension",
  "pdf",
] as const;

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
  Math.max(MIN_LOCAL_HISTORY_TOKENS, Math.floor(contextWindow * 0.85));

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

/**
 * Detects a "routing surface changed" transition between the latest and
 * the previous user message in a conversation and returns the hidden
 * system-reminder text the orchestrator should see (or `undefined` when
 * nothing changed).
 *
 * "Routing surface" here means whether the user is talking through a
 * connector (Linq SMS, Slack, Discord, etc.) or directly from the
 * desktop, and which connector if so. Each `user_message` event carries
 * `payload.source` (either `"connector"` or absent) and, when sourced
 * from a connector, `payload.provider` identifying the channel.
 *
 * The reminder is only injected on the transition turn — once the model
 * has acknowledged the new surface, subsequent same-surface user
 * messages skip the reminder so we don't burn cache or nag the model.
 *
 * - desktop → connector: tell the orchestrator the user is on
 *   `<provider>`, ask it to reply in plain text and skip the
 *   `askQuestion` / `html` tools (they're desktop-renderer UI).
 * - connector → desktop: tell the orchestrator the user is back at
 *   their desktop so it stops constraining its format.
 * - connector → different connector: same as desktop → connector with
 *   the new provider name.
 * - same surface: returns `undefined`.
 */
const buildConnectorTransitionReminder = (
  events: LocalContextEvent[],
): string | undefined => {
  const userEvents = events.filter((event) => event.type === "user_message");
  if (userEvents.length === 0) return undefined;

  const latest = userEvents[userEvents.length - 1];
  const previous = userEvents[userEvents.length - 2];

  const sourceOf = (
    event: LocalContextEvent | undefined,
  ): { isConnector: boolean; provider: string | null } => {
    if (!event?.payload || typeof event.payload !== "object") {
      return { isConnector: false, provider: null };
    }
    const payload = event.payload as Record<string, unknown>;
    if (payload.source !== "connector") {
      return { isConnector: false, provider: null };
    }
    const provider =
      typeof payload.provider === "string" && payload.provider.trim()
        ? payload.provider.trim()
        : null;
    return { isConnector: true, provider };
  };

  const currentSurface = sourceOf(latest);
  const previousSurface = sourceOf(previous);

  // No transition: same surface (and same provider when on a connector).
  if (
    currentSurface.isConnector === previousSurface.isConnector &&
    currentSurface.provider === previousSurface.provider
  ) {
    return undefined;
  }

  if (currentSurface.isConnector) {
    const providerLabel = currentSurface.provider ?? "an external chat channel";
    return [
      `The user just switched to messaging you from ${providerLabel} (not the desktop app).`,
      "Reply in plain text only — no markdown, no headers, no bullet lists, no code blocks. Write like a normal text message.",
      "Do not call the `askQuestion` tool (the chip UI does not render on the user's phone — ask any question inline in chat instead).",
      "Do not call the `html` tool (HTML/canvas artifacts only render in the desktop sidebar — type the answer in chat instead).",
      "After calling `image_gen`, do not narrate or describe the image you just made — the generated file is delivered to the user's chat directly when it finishes, separately from your text reply. Saying \"here's the image\" reads as broken because the image arrives later as its own message.",
      "Keep replies short and conversational.",
    ].join(" ");
  }

  // connector → desktop
  return "The user is back at their desktop. You can respond normally again — markdown, the `askQuestion` tool, the `html` tool, image-gen narration, and other desktop-only surfaces are all fine.";
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
  if (
    latestUserEvent.timestamp - previousUserEvent.timestamp <
    THIRTY_MINUTES_MS
  ) {
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
  const warningThresholdTokens = getLocalHistoryWarningThreshold(
    args.contextWindow,
  );

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
  stellaHome,
  stellaBrowserBinPath,
  stellaOfficeBinPath,
  stellaComputerCliPath,
  stellaConnectCliPath,
  cliBridgeSocketPath,
  selfModMonitor,
  selfModLifecycle,
  selfModHmrController,
  requestCredential,
  requestRuntimeAuthRefresh,
  notifyVoiceActionComplete,
  scheduleApi,

  fashionApi,
  runtimeStore,
  getAppBrowserContext,
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

  const convexAction = async (
    ref: unknown,
    args: unknown,
  ): Promise<unknown> => {
    const deploymentUrl = sanitizeConvexDeploymentUrl(
      context.state?.convexDeploymentUrl ?? envConvexDeploymentUrl,
    );
    const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
    if (!deploymentUrl || !authToken) {
      throw new Error("Convex connection and auth are required.");
    }

    const existingClient = context.state?.convexClient;
    if (existingClient && context.state?.convexClientUrl === deploymentUrl) {
      return await (
        existingClient as {
          action: (tool: unknown, params: unknown) => Promise<unknown>;
        }
      ).action(ref, args);
    }

    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => authToken);
    try {
      return await (
        client as {
          action: (tool: unknown, params: unknown) => Promise<unknown>;
        }
      ).action(ref, args);
    } finally {
      void client.close().catch(() => undefined);
    }
  };

  const resolvedFashionApi =
    fashionApi ?? createFashionApi({ convexAction, convexApi: anyApi });

  const toolHost = createToolHost({
    stellaRoot,
    stellaHome,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaConnectCliPath,
    cliBridgeSocketPath,
    requestCredential,
    notifyVoiceActionComplete,
    getSubagentTypes: () =>
      collectSubagentRoster(context.state.loadedAgents).map(
        (entry) => entry.type,
      ),
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
      const baseUrl = sanitizeStellaBase(
        context.state?.convexSiteUrl ?? envProxyBaseUrl,
      );
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
        return await (
          existingClient as {
            query: (tool: unknown, params: unknown) => Promise<unknown>;
          }
        ).query(ref, args);
      }

      const client = new ConvexClient(deploymentUrl, {
        logger: false,
        unsavedChangesWarning: false,
      });
      client.setAuth(async () => authToken);
      try {
        return await (
          client as {
            query: (tool: unknown, params: unknown) => Promise<unknown>;
          }
        ).query(ref, args);
      } finally {
        void client.close().catch(() => undefined);
      }
    },
    contextProvider: async (payload) => {
      const agent = resolveAgent(context, AGENT_IDS.ORCHESTRATOR);
      const model = getConfiguredModel(context, AGENT_IDS.ORCHESTRATOR, agent);
      const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
        context,
        AGENT_IDS.ORCHESTRATOR,
        model,
      );
      const localEvents = context.listLocalChatEvents
        ? context
            .listLocalChatEvents(payload.conversationId, 800)
            .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type))
        : [];
      const appBrowserContext = getAppBrowserContext
        ? await getAppBrowserContext()
        : undefined;
      return await runContextLookup({
        conversationId: payload.conversationId,
        lookupPrompt: payload.prompt,
        ...(payload.memorySearchTerms?.length
          ? { memorySearchTerms: payload.memorySearchTerms }
          : {}),
        stellaRoot,
        stellaHome,
        store: context.runtimeStore,
        localEvents,
        ...(appBrowserContext ? { appBrowserContext } : {}),
        resolvedLlm,
        ...(payload.signal ? { signal: payload.signal } : {}),
      });
    },
    ...(runtimeStore?.threadSummariesStore
      ? { threadSummariesStore: runtimeStore.threadSummariesStore }
      : {}),
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
        return await context.state.localAgentManager.cancelAgent(
          agentId,
          reason,
        );
      },
      sendAgentMessage: async (agentId, message, from) => {
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
        );
      },
      drainAgentMessages: async (agentId, recipient) => {
        if (
          !context.state.localAgentManager ||
          typeof context.state.localAgentManager.drainAgentMessages !==
            "function"
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
    stellaHome,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaComputerCliPath,
    selfModMonitor,
    selfModLifecycle,
    selfModHmrController,
    requestCredential,
    requestRuntimeAuthRefresh,
    notifyVoiceActionComplete,
    scheduleApi,

    fashionApi: resolvedFashionApi,
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
      orchestratorSessions: new Map(),
      compactionScheduler: new BackgroundCompactionScheduler(),
      queuedOrchestratorTurns: [],
      activeRunAbortControllers: new Map(),
      conversationCallbacks: new Map(),
      runCallbacksByRunId: new Map(),
      loadedAgents: [],
      webSearch: null,
    },
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
  const modelFromPrefs = getModelOverride(context.stellaHome, agentType);
  return modelFromPrefs ?? agent?.model;
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
      mode?: "author" | "install" | "update" | "uninstall" | "desktop-update";
    };
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
  let connectorTransitionReminderText: string | undefined;
  // Locale is plumbed onto user-message payloads alongside `timezone`, so
  // we read whatever was most recently sent. The orchestrator path
  // already loads recent local events to build history; subagent paths
  // make a fresh, smaller fetch since they don't otherwise need the
  // local-events stream.
  let userLocale: string | undefined;
  // The orchestrator-shape thread history (merged stored thread messages +
  // recent local events) and the runtime reminders (stale-user reminder,
  // active-threads prompt) are gated by the `injectsRuntimeReminders`
  // capability rather than a literal `agentType === ORCHESTRATOR` check, so
  // future user-facing agents inherit the shape by data, not code.
  const injectsRuntimeReminders = agentHasCapability(
    args.agentType,
    "injectsRuntimeReminders",
  );
  if (injectsRuntimeReminders && context.listLocalChatEvents) {
    const localEvents = context
      .listLocalChatEvents(args.conversationId, 800)
      .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
    staleUserReminderText = buildStaleUserReminder(localEvents);
    connectorTransitionReminderText =
      buildConnectorTransitionReminder(localEvents);
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

  const activeThreadsPrompt = injectsRuntimeReminders
    ? buildActiveThreadsPrompt(
        context.runtimeStore.listActiveThreads(args.conversationId),
      )
    : "";
  const dynamicContextSections: string[] = [];

  // Inject the user's response-language directive at the top of the
  // dynamic context. It's a single line, comes from the latest
  // `user_message` event's `locale` payload, and is `undefined` for
  // English so we don't waste tokens on a no-op directive.
  const responseLanguageDirective = getResponseLanguageSystemPrompt(userLocale);
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
    injectsRuntimeReminders && activeThreadsPrompt
      ? context.runtimeStore.getOrchestratorReminderState(args.conversationId)
      : {
          shouldInjectDynamicReminder: false,
          reminderTokensSinceLastInjection: 0,
        };
  const storedEngine = getAgentRuntimeEngine(context.stellaHome);
  const agentEngine =
    args.agentType === AGENT_IDS.GENERAL && isCursorModelOverride(model)
      ? "cursor_sdk"
      : storedEngine;

  const fileEditToolFamily = getFileEditToolFamily({
    agentType: args.agentType,
    model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
    agentEngine,
  });
  const toolsAllowlist = rewriteFileEditToolNames(
    agent?.toolsAllowlist,
    fileEditToolFamily,
  );
  if (fileEditToolFamily === "write_edit") {
    dynamicContextSections.push(
      [
        "## File Editing Tools",
        "This run is using a non-OpenAI model. Use `Write` for new or full-file edits and `Edit` for targeted replacements.",
        "`apply_patch` is not available in this run.",
      ].join("\n"),
    );
  }
  if (agentHasCapability(args.agentType, "injectsSkillCatalog")) {
    const skillCatalogOptions =
      agentEngine === "codex_cli"
        ? { omitSkillIds: CODEX_SKILL_CATALOG_OMITTED_IDS }
        : undefined;
    dynamicContextSections.push(
      await renderSkillCatalogBlock(context.stellaHome, skillCatalogOptions),
    );
  }
  if (agentHasCapability(args.agentType, "injectsSubagentRoster")) {
    dynamicContextSections.push(
      renderSubagentRosterBlock(
        collectSubagentRoster(context.state.loadedAgents),
      ),
    );
  }

  return {
    systemPrompt:
      agent?.systemPrompt || defaultPromptForAgentType(args.agentType),
    dynamicContext: dynamicContextSections.join("\n\n"),
    orchestratorReminderText: activeThreadsPrompt || undefined,
    shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
    staleUserReminderText,
    connectorTransitionReminderText,
    toolsAllowlist,
    model,
    reasoningEffort: getReasoningEffort(context.stellaHome, args.agentType),
    maxAgentDepth: agent?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH,
    coreMemory: readCoreMemory(context.stellaHome),
    threadHistory: threadHistory.length > 0 ? threadHistory : undefined,
    activeThreadId: threadKey,
    agentEngine,
    maxAgentConcurrency: isLocalCliAgentId(args.agentType)
      ? getMaxAgentConcurrency(context.stellaHome)
      : undefined,
  };
};
