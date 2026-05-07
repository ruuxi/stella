import {
  runOrchestratorTurn,
  type RuntimeRunCallbacks,
} from "../agent-runtime.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { getOrCreateOrchestratorSession } from "../agent-runtime/orchestrator-session.js";
import {
  resolveRunnerLlmRoute,
  resolveRunnerLlmRouteWithMetadata,
} from "./model-selection.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import type { RunnerContext } from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import { agentHasCapability } from "../../contracts/agent-runtime.js";

type BuildAgentContext = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
  toolWorkspaceRoot?: string;
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
  toolWorkspaceRoot?: string;
  agentContext: LocalAgentContext;
  resolvedLlm: ReturnType<typeof resolveRunnerLlmRoute>;
  abortController: AbortController;
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
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  toolWorkspaceRoot?: string;
}): Promise<PreparedOrchestratorRun> => {
  const isUserTurn = args.uiVisibility !== "hidden";

  const agentContext = await args.buildAgentContext({
    conversationId: args.conversationId,
    agentType: args.agentType,
    runId: args.runId,
    ...(args.toolWorkspaceRoot ? { toolWorkspaceRoot: args.toolWorkspaceRoot } : {}),
  });
  const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
    args.context,
    args.agentType,
    agentContext.model,
  );

  args.context.state.activeOrchestratorRunId = args.runId;
  args.context.state.activeOrchestratorConversationId = args.conversationId;
  args.context.state.activeOrchestratorUiVisibility =
    args.uiVisibility ?? "visible";

  const abortController = new AbortController();
  args.context.state.activeRunAbortControllers.set(args.runId, abortController);

  // Increment the memory-review counter only on real user-driven turns
  // for agents that declare the `triggersMemoryReview` capability.
  // Synthetic task-callback turns (uiVisibility === "hidden") and
  // capability-less agents do not count — they would inflate the counter
  // without representing user input.
  let userTurnsSinceMemoryReview: number | undefined;
  if (
    isUserTurn &&
    agentHasCapability(args.agentType, "triggersMemoryReview")
  ) {
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
    ...(args.toolWorkspaceRoot
      ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
      : {}),
    agentContext,
    resolvedLlm,
    abortController,
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
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
}): void => {
  const { prepared, context } = args;

  // Long-lived per-conversation session for the Pi engine path. The Pi
  // path inside `runOrchestratorTurn` routes through `session.runTurn(opts)`
  // so the underlying `Agent` (and its `state.messages`) survives across
  // turns. External engines ignore the session and use their own per-turn
  // flow.
  const orchestratorSession = getOrCreateOrchestratorSession(
    context.state.orchestratorSessions,
    prepared.conversationId,
  );

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
    ...(prepared.responseTarget
      ? { responseTarget: prepared.responseTarget }
      : {}),
    attachments: prepared.attachments,
    agentContext: prepared.agentContext,
    callbacks: args.runtimeCallbacks,
    toolCatalog: context.toolHost.getToolCatalog(prepared.agentType, {
      model: prepared.resolvedLlm.toolPolicyModel ?? prepared.resolvedLlm.model,
    }),
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
    ...(prepared.toolWorkspaceRoot
      ? { toolWorkspaceRoot: prepared.toolWorkspaceRoot }
      : {}),
    selfModMonitor: context.selfModMonitor,
    hookEmitter: context.hookEmitter,
    onExecutionSessionCreated: args.onExecutionSessionCreated,
    orchestratorSession,
    compactionScheduler: context.state.compactionScheduler,
    ...(prepared.userTurnsSinceMemoryReview != null
      ? { userTurnsSinceMemoryReview: prepared.userTurnsSinceMemoryReview }
      : {}),
  }).catch((error) => {
    if (isReportedOrchestratorError(error)) {
      return;
    }
    args.cleanupRun(prepared.runId);
    args.onFatalError(error);
  });
};

export const startPreparedOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
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
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
  onPrepared?: (prepared: PreparedOrchestratorRun) => void;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
}): Promise<{ runId: string; prepared: PreparedOrchestratorRun }> => {
  const prepared = await prepareOrchestratorRun({
    context: args.context,
    buildAgentContext: args.buildAgentContext,
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
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
    cleanupRun: args.cleanupRun,
    onFatalError: args.onFatalError,
  });

  return { runId: args.runId, prepared };
};
