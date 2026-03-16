import { createRuntimeLogger } from "../debug.js";
import { createDisplayStreamController } from "./display-stream.js";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorSuccess,
  finalizeSubagentError,
  finalizeSubagentSuccess,
} from "./run-completion.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createUserPromptMessage,
} from "./run-preparation.js";
import { subscribeRuntimeAgentEvents } from "./run-events.js";
import {
  createOrchestratorExecutionSession,
  createSubagentExecutionSession,
} from "./run-session.js";
import {
  getAgentCompletion,
  now,
} from "./shared.js";
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

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const displayStream = createDisplayStreamController(opts.displayHtml);

  const unsubscribe = subscribeRuntimeAgentEvents({
    agent,
    runId,
    agentType: opts.agentType,
    recorder: runEvents,
    callbacks: opts.callbacks,
    displayEventHandler: displayStream.handleEvent,
    hookEmitter: opts.hookEmitter,
  });

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

    await agent.prompt({
      ...createUserPromptMessage(promptText),
      timestamp: now(),
    });

    displayStream.flush();

    const { finalText, errorMessage } = getAgentCompletion(agent);
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
  } finally {
    displayStream.dispose();
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
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

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = subscribeRuntimeAgentEvents({
    agent,
    runId,
    agentType: opts.agentType,
    recorder: runEvents,
    callbacks: opts.callbacks,
    onProgress: opts.onProgress,
  });

  try {
    await agent.prompt({
      ...createUserPromptMessage(prompt),
      timestamp: now(),
    });

    const { finalText: result, errorMessage } = getAgentCompletion(agent);
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
  } finally {
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
};
