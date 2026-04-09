import { createRuntimeLogger } from "../debug.js";
import { createDisplayStreamController } from "./display-stream.js";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorSuccess,
  finalizeSubagentError,
  finalizeSubagentSuccess,
  markOrchestratorErrorReported,
} from "./run-completion.js";
import { executeRuntimeAgentPrompt } from "./run-execution.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
} from "./run-preparation.js";
import {
  createOrchestratorExecutionSession,
  createSubagentExecutionSession,
} from "./run-session.js";
import {
  buildOrchestratorPromptMessages,
} from "./thread-memory.js";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";

const logger = createRuntimeLogger("agent-runtime");

export const runPiOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string> => {
  const baselineHead =
    opts.frontendRoot && opts.selfModMonitor
      ? await opts.selfModMonitor
          .getBaselineHead(opts.frontendRoot)
          .catch(() => null)
      : null;

  const effectiveSystemPrompt = await buildRuntimeSystemPrompt(opts);

  const { runId, threadKey, runEvents, tools, agent } =
    createOrchestratorExecutionSession({
      ...opts,
      systemPrompt: effectiveSystemPrompt,
    });

  logger.debug("orchestrator.start", {
    runId,
    agentType: opts.agentType,
    model: opts.resolvedLlm.model.id,
    conversationId: opts.conversationId,
    promptPreview: opts.userPrompt.slice(0, 300),
  });

  runEvents.recordRunStart();

  logger.debug("orchestrator.tools", {
    agentType: opts.agentType,
    tools: tools.map((tool) => ({
      name: tool.name,
      hasDesc: !!tool.description,
      paramKeys: Object.keys(
        ((tool.parameters as Record<string, unknown>)?.properties ??
          {}) as Record<string, unknown>,
      ),
    })),
  });

  if (opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const displayStream = createDisplayStreamController(opts.displayHtml);

  try {
    const promptMessages = buildOrchestratorPromptMessages(
      opts.agentContext,
      opts.userPrompt,
      opts.promptMessages,
    );
    logger.info("orchestrator.prompt-shape", {
      runId,
      conversationId: opts.conversationId,
      userPrompt: opts.userPrompt,
      promptMessages: promptMessages.map((message, index) => ({
        index,
        uiVisibility: message.uiVisibility ?? "visible",
        textPreview: message.text.slice(0, 200),
        attachmentCount:
          index === promptMessages.length - 1
            ? (opts.attachments?.length ?? 0)
            : 0,
      })),
    });

    const { finalText, errorMessage } = await executeRuntimeAgentPrompt({
      agent,
      promptMessages: promptMessages.map((message, index) => ({
        ...message,
        ...(index === promptMessages.length - 1 && opts.attachments?.length
          ? { attachments: opts.attachments }
          : {}),
      })),
      runId,
      agentType: opts.agentType,
      recorder: runEvents,
      abortSignal: opts.abortSignal,
      callbacks: opts.callbacks,
      displayEventHandler: displayStream.handleEvent,
      hookEmitter: opts.hookEmitter,
      threadStore: opts.store,
      threadKey,
      onAfterPrompt: () => {
        displayStream.flush();
      },
      onCleanup: () => {
        displayStream.dispose();
      },
    });
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    await finalizeOrchestratorSuccess({
      opts,
      runId,
      threadKey,
      runEvents,
      agent,
      finalText,
      baselineHead,
    });

    return runId;
  } catch (error) {
    finalizeOrchestratorError({
      opts,
      runEvents,
      error,
    });
    throw markOrchestratorErrorReported(error);
  }
};

export const runPiSubagentTask = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult> => {
  const prompt = opts.userPrompt.trim();
  const effectiveSystemPrompt = buildSubagentSystemPrompt(opts);
  const { runId, threadKey, runEvents, agent } =
    createSubagentExecutionSession({
      ...opts,
      systemPrompt: effectiveSystemPrompt,
    });
  const isDashboardGeneration =
    opts.agentType === "dashboard_generation";
  const dashboardLabel = prompt.split("\n")[0]?.trim() || "(unknown)";
  runEvents.recordRunStart();
  if (isDashboardGeneration) {
    logger.info("dashboard.run.start", {
      runId,
      conversationId: opts.conversationId,
      threadKey,
      label: dashboardLabel,
    });
    opts.abortSignal?.addEventListener(
      "abort",
      () => {
        logger.warn("dashboard.run.abort-signal", {
          runId,
          conversationId: opts.conversationId,
          label: dashboardLabel,
          reason:
            opts.abortSignal?.reason instanceof Error
              ? opts.abortSignal.reason.message
              : String(opts.abortSignal?.reason ?? "unknown"),
        });
      },
      { once: true },
    );
  }

  if (opts.abortSignal?.aborted) {
    runEvents.recordError("Aborted");
    if (isDashboardGeneration) {
      logger.warn("dashboard.run.aborted-before-execute", {
        runId,
        conversationId: opts.conversationId,
        label: dashboardLabel,
      });
    }
    return { runId, result: "", error: "Aborted" };
  }

  try {
    const { finalText: result, errorMessage } = await executeRuntimeAgentPrompt({
      agent,
      promptText: prompt,
      runId,
      agentType: opts.agentType,
      recorder: runEvents,
      abortSignal: opts.abortSignal,
      callbacks: opts.callbacks,
      onProgress: opts.onProgress,
      threadStore: opts.store,
      threadKey,
    });
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    if (isDashboardGeneration) {
      logger.info("dashboard.run.execute-finished", {
        runId,
        conversationId: opts.conversationId,
        label: dashboardLabel,
        resultLength: result.length,
      });
    }
    return await finalizeSubagentSuccess({
      opts,
      runEvents,
      runId,
      threadKey,
      result,
    });
  } catch (error) {
    if (isDashboardGeneration) {
      logger.error("dashboard.run.execute-error", {
        runId,
        conversationId: opts.conversationId,
        label: dashboardLabel,
        error,
      });
    }
    return finalizeSubagentError({
      opts,
      runEvents,
      runId,
      error,
    });
  }
};
