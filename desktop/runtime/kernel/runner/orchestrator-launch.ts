import { runOrchestratorTurn, type RuntimeRunCallbacks } from "../agent-runtime.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import { resolveRunnerLlmRoute } from "./model-selection.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import type {
  QueuedOrchestratorTurn,
  RunnerContext,
} from "./types.js";
import type { RuntimeAttachmentRef } from "../../protocol/index.js";

type BuildAgentContext = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}) => Promise<LocalTaskManagerAgentContext>;

type WebSearch = (
  query: string,
  options?: { category?: string; displayResults?: boolean },
) => Promise<{
  text: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}>;

export type PreparedOrchestratorRun = {
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  attachments: RuntimeAttachmentRef[];
  agentContext: LocalTaskManagerAgentContext;
  resolvedLlm: ReturnType<typeof resolveRunnerLlmRoute>;
  abortController: AbortController;
  replayInterruptedTurn: () => void;
};

export const prepareOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  runId: string;
  conversationId: string;
  agentType: string;
  userPrompt: string;
  attachments: RuntimeAttachmentRef[];
  replayTurn?: QueuedOrchestratorTurn | null;
}): Promise<PreparedOrchestratorRun> => {
  const agentContext = await args.buildAgentContext({
    conversationId: args.conversationId,
    agentType: args.agentType,
    runId: args.runId,
  });
  const resolvedLlm = resolveRunnerLlmRoute(
    args.context,
    args.agentType,
    agentContext.model,
  );

  args.context.state.activeOrchestratorRunId = args.runId;
  args.context.state.activeOrchestratorConversationId = args.conversationId;
  args.context.state.activeInterruptedReplayTurn = args.replayTurn ?? null;

  const abortController = new AbortController();
  args.context.state.activeRunAbortControllers.set(args.runId, abortController);
  const replayTurn = args.replayTurn ?? null;

  const replayInterruptedTurn = () => {
    if (replayTurn) {
      args.queueOrchestratorTurn(replayTurn);
    }
  };

  return {
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    userPrompt: args.userPrompt,
    attachments: args.attachments,
    agentContext,
    resolvedLlm,
    abortController,
    replayInterruptedTurn,
  };
};

export const launchPreparedOrchestratorRun = (args: {
  context: RunnerContext;
  prepared: PreparedOrchestratorRun;
  userMessageId: string;
  runtimeCallbacks: RuntimeRunCallbacks;
  webSearch: WebSearch;
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
    attachments: prepared.attachments,
    agentContext: prepared.agentContext,
    callbacks: args.runtimeCallbacks,
    toolCatalog: context.toolHost.getToolCatalog(),
    toolExecutor: (toolName, toolArgs, toolContext) =>
      context.toolHost.executeTool(toolName, toolArgs, toolContext),
    deviceId: context.deviceId,
    stellaHome: context.stellaHomePath,
    resolvedLlm: prepared.resolvedLlm,
    store: context.runtimeStore,
    abortSignal: prepared.abortController.signal,
    frontendRoot: context.frontendRoot,
    selfModMonitor: context.selfModMonitor,
    webSearch: args.webSearch,
    hookEmitter: context.hookEmitter,
    displayHtml: context.displayHtml,
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
  attachments: RuntimeAttachmentRef[];
  userMessageId: string;
  webSearch: WebSearch;
  finishInterruptedRun: (args: {
    runId: string;
    onInterrupted?: () => void;
    onCleanup?: () => void;
  }) => boolean;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
  onPrepared?: (prepared: PreparedOrchestratorRun) => void;
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
    webSearch: args.webSearch,
    finishInterruptedRun: args.finishInterruptedRun,
    cleanupRun: args.cleanupRun,
    onFatalError: args.onFatalError,
  });

  return { runId: args.runId, prepared };
};
