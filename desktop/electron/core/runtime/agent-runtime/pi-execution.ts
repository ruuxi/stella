import { createRuntimeLogger } from "../debug.js";
import { createDisplayStreamController } from "./display-stream.js";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorSuccess,
  finalizeSubagentError,
  finalizeSubagentSuccess,
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
  appendThreadMessage,
  buildOrchestratorUserPrompt,
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
    const promptText = buildOrchestratorUserPrompt(
      opts.agentContext,
      opts.userPrompt,
    );
    appendThreadMessage(opts.store, {
      threadKey,
      role: "user",
      content: opts.userPrompt,
    });

    const { finalText, errorMessage } = await executeRuntimeAgentPrompt({
      agent,
      promptText,
      runId,
      agentType: opts.agentType,
      recorder: runEvents,
      abortSignal: opts.abortSignal,
      callbacks: opts.callbacks,
      displayEventHandler: displayStream.handleEvent,
      hookEmitter: opts.hookEmitter,
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
    throw error;
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
  runEvents.recordRunStart();

  if (prompt) {
    appendThreadMessage(opts.store, {
      threadKey,
      role: "user",
      content: prompt,
    });
  }

  if (opts.abortSignal?.aborted) {
    runEvents.recordError("Aborted");
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
    });
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return await finalizeSubagentSuccess({
      opts,
      runEvents,
      runId,
      threadKey,
      result,
    });
  } catch (error) {
    return finalizeSubagentError({
      opts,
      runEvents,
      runId,
      error,
    });
  }
};
