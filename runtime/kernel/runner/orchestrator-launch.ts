import { runOrchestratorTurn, type RuntimeRunCallbacks } from "../agent-runtime.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { resolveRunnerLlmRoute } from "./model-selection.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import { MEMORY_INJECTION_TURN_THRESHOLD } from "../agent-runtime/thread-memory.js";
import type {
  QueuedOrchestratorTurn,
  RunnerContext,
} from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import { AGENT_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";

type BuildAgentContext = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
  shouldInjectDynamicMemory?: boolean;
}) => Promise<LocalAgentContext>;

export type PreparedOrchestratorRun = {
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  agentContext: LocalAgentContext;
  resolvedLlm: ReturnType<typeof resolveRunnerLlmRoute>;
  abortController: AbortController;
  replayInterruptedTurn: () => void;
  /**
   * Memory-review user-turn counter AFTER incrementing for this run.
   * Only set when the run is a real user turn (Orchestrator + uiVisibility !== "hidden").
   * Consumed by finalizeOrchestratorSuccess to decide whether to spawn the review.
   */
  userTurnsSinceMemoryReview?: number;
};

export const prepareOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  replayTurn?: QueuedOrchestratorTurn | null;
}): Promise<PreparedOrchestratorRun> => {
  // Decide whether this turn should re-inject the memory bundle BEFORE we
  // build the agent context, so context construction can skip the snapshot
  // formatting work on turns we won't inject. Only real Orchestrator user
  // turns count toward the cadence — synthetic hidden turns coast on
  // whatever the prior real turn injected.
  const isRealOrchestratorTurn =
    args.agentType === AGENT_IDS.ORCHESTRATOR
    && args.uiVisibility !== "hidden";
  let shouldInjectDynamicMemory = false;
  if (isRealOrchestratorTurn) {
    try {
      const counter =
        args.context.runtimeStore.incrementUserTurnsSinceMemoryInjection(
          args.conversationId,
        );
      if (counter === 1 || counter > MEMORY_INJECTION_TURN_THRESHOLD) {
        shouldInjectDynamicMemory = true;
        if (counter > 1) {
          // Roll the counter back to 1 so the next 40 turns coast again.
          args.context.runtimeStore.resetUserTurnsSinceMemoryInjection(
            args.conversationId,
          );
        }
      }
    } catch {
      // Memory injection cadence is best-effort. Counter failure must not
      // block the turn — fall back to "don't inject" to avoid spamming the
      // bundle on every failure.
    }
  }

  const agentContext = await args.buildAgentContext({
    conversationId: args.conversationId,
    agentType: args.agentType,
    runId: args.runId,
    ...(shouldInjectDynamicMemory ? { shouldInjectDynamicMemory: true } : {}),
  });
  const resolvedLlm = resolveRunnerLlmRoute(
    args.context,
    args.agentType,
    agentContext.model,
  );

  args.context.state.activeOrchestratorRunId = args.runId;
  args.context.state.activeOrchestratorConversationId = args.conversationId;
  args.context.state.activeOrchestratorUiVisibility = args.uiVisibility ?? "visible";
  args.context.state.activeInterruptedReplayTurn = args.replayTurn ?? null;

  const abortController = new AbortController();
  args.context.state.activeRunAbortControllers.set(args.runId, abortController);
  const replayTurn = args.replayTurn ?? null;

  const replayInterruptedTurn = () => {
    if (replayTurn) {
      args.queueOrchestratorTurn(replayTurn);
    }
  };

  // Increment the memory-review user-turn counter only on real user-driven
  // Orchestrator turns. Synthetic task-callback turns (uiVisibility === "hidden")
  // do not count - they would inflate the counter without representing user input.
  let userTurnsSinceMemoryReview: number | undefined;
  if (isRealOrchestratorTurn) {
    try {
      userTurnsSinceMemoryReview =
        args.context.runtimeStore.incrementUserTurnsSinceMemoryReview(
          args.conversationId,
        );
    } catch {
      // Memory review is best-effort. Counter failure must not block the turn.
    }
  }

  return {
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
    agentContext,
    resolvedLlm,
    abortController,
    replayInterruptedTurn,
    ...(userTurnsSinceMemoryReview != null
      ? { userTurnsSinceMemoryReview }
      : {}),
  };
};

export const launchPreparedOrchestratorRun = (args: {
  context: RunnerContext;
  prepared: PreparedOrchestratorRun;
  userMessageId: string;
  runtimeCallbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
  finishInterruptedRun: (args: {
    runId: string;
    onInterrupted?: () => void;
    onCleanup?: () => void;
  }) => boolean;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
}): void => {
  const {
    prepared,
    context,
  } = args;

  void runOrchestratorTurn({
    runId: prepared.runId,
    conversationId: prepared.conversationId,
    userMessageId: args.userMessageId,
    agentType: prepared.agentType,
    userPrompt: prepared.userPrompt,
    ...(prepared.uiVisibility ? { uiVisibility: prepared.uiVisibility } : {}),
    ...(prepared.promptMessages?.length
      ? { promptMessages: prepared.promptMessages }
      : {}),
    ...(prepared.responseTarget ? { responseTarget: prepared.responseTarget } : {}),
    attachments: prepared.attachments,
    agentContext: prepared.agentContext,
    callbacks: args.runtimeCallbacks,
    toolCatalog: context.toolHost.getToolCatalog(prepared.agentType),
    toolExecutor: (toolName, toolArgs, toolContext, signal, onUpdate) =>
      context.toolHost.executeTool(
        toolName,
        toolArgs,
        toolContext,
        signal,
        onUpdate,
      ),
    deviceId: context.deviceId,
    stellaHome: context.stellaRoot,
    resolvedLlm: prepared.resolvedLlm,
    store: context.runtimeStore,
    abortSignal: prepared.abortController.signal,
    stellaRoot: context.stellaRoot,
    selfModMonitor: context.selfModMonitor,
    hookEmitter: context.hookEmitter,
    displayHtml: context.displayHtml,
    onExecutionSessionCreated: args.onExecutionSessionCreated,
    ...(prepared.userTurnsSinceMemoryReview != null
      ? { userTurnsSinceMemoryReview: prepared.userTurnsSinceMemoryReview }
      : {}),
  }).catch((error) => {
    if (isReportedOrchestratorError(error)) {
      return;
    }
    if (
      args.finishInterruptedRun({
        runId: prepared.runId,
        onInterrupted: prepared.replayInterruptedTurn,
      })
    ) {
      return;
    }
    args.cleanupRun(prepared.runId);
    args.onFatalError(error);
  });
};

export const startPreparedOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  createRuntimeCallbacks: (args: {
    runId: string;
    prepared: PreparedOrchestratorRun;
  }) => RuntimeRunCallbacks;
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  userMessageId: string;
  finishInterruptedRun: (args: {
    runId: string;
    onInterrupted?: () => void;
    onCleanup?: () => void;
  }) => boolean;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
  onPrepared?: (prepared: PreparedOrchestratorRun) => void;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
  replayTurn?: QueuedOrchestratorTurn | null;
}): Promise<{ runId: string; prepared: PreparedOrchestratorRun }> => {
  const prepared = await prepareOrchestratorRun({
    context: args.context,
    buildAgentContext: args.buildAgentContext,
    queueOrchestratorTurn: args.queueOrchestratorTurn,
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
    replayTurn: args.replayTurn,
  });

  args.onPrepared?.(prepared);

  launchPreparedOrchestratorRun({
    context: args.context,
    prepared,
    userMessageId: args.userMessageId,
    runtimeCallbacks: args.createRuntimeCallbacks({
      runId: args.runId,
      prepared,
    }),
    onExecutionSessionCreated: args.onExecutionSessionCreated,
    finishInterruptedRun: args.finishInterruptedRun,
    cleanupRun: args.cleanupRun,
    onFatalError: args.onFatalError,
  });

  return { runId: args.runId, prepared };
};
