import crypto from "crypto";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import { now, resolveLocalCliCwd } from "./shared.js";
import {
  appendThreadMessage,
  buildRunThreadKey,
  buildSelfModDocumentationPrompt,
  buildSystemPrompt,
  persistAssistantReply,
} from "./thread-memory.js";
import type { SubagentRunOptions, SubagentRunResult } from "./types.js";
import {
  isLocalCliAgentId,
  shouldIncludeStellaDocumentation,
  RUNTIME_RUN_EVENT_TYPES,
} from "../../../../src/shared/contracts/agent-runtime.js";

const emitStreamChunk = (
  opts: SubagentRunOptions,
  runId: string,
  nextSeq: () => number,
  chunk: string,
) => {
  if (!chunk) {
    return;
  }
  opts.onProgress?.(chunk);
  const seq = nextSeq();
  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    seq,
    type: RUNTIME_RUN_EVENT_TYPES.STREAM,
    chunk,
  });
  opts.callbacks?.onStream?.({
    runId,
    agentType: opts.agentType,
    seq,
    chunk,
  });
};

export const runExternalSubagentTurn = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult | null> => {
  const primaryModelId = opts.agentContext.model;
  if (!isLocalCliAgentId(opts.agentType)) {
    return null;
  }

  const wantsClaudeRuntime =
    opts.agentContext.agentEngine === "claude_code_local" ||
    (primaryModelId && isClaudeCodeModel(primaryModelId));

  if (!wantsClaudeRuntime) {
    return null;
  }

  const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;
  const prompt = opts.userPrompt.trim();
  const effectiveSystemPrompt = [
    buildSystemPrompt(opts.agentContext),
    shouldIncludeStellaDocumentation(opts.agentType)
      ? buildSelfModDocumentationPrompt(opts.frontendRoot)
      : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  const threadKey = buildRunThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  let seq = 0;
  const nextSeq = () => ++seq;

  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    type: RUNTIME_RUN_EVENT_TYPES.RUN_START,
  });

  if (prompt) {
    appendThreadMessage(opts.store, {
      threadKey,
      role: "user",
      content: prompt,
    });
  }

  if (opts.abortSignal?.aborted) {
    const errSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: RUNTIME_RUN_EVENT_TYPES.ERROR,
      error: "Aborted",
      fatal: true,
    });
    return { runId, result: "", error: "Aborted" };
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: opts.agentType,
    frontendRoot: opts.frontendRoot,
  });
  const sessionKey = opts.agentContext.activeThreadId
    ? `${opts.conversationId}:${opts.agentContext.activeThreadId}`
    : `${opts.conversationId}:run:${runId}`;

  try {
    const result = await runClaudeCodeTurn({
      runId,
      sessionKey,
      modelId: primaryModelId!,
      prompt,
      systemPrompt: effectiveSystemPrompt,
      cwd: localCliCwd,
      abortSignal: opts.abortSignal,
      onProgress: (chunk) => {
        emitStreamChunk(opts, runId, nextSeq, chunk);
      },
    });
    await persistAssistantReply({
      store: opts.store,
      threadKey,
      resolvedLlm: opts.resolvedLlm,
      agentType: opts.agentType,
      content: result.text,
    });
    const endSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: endSeq,
      type: RUNTIME_RUN_EVENT_TYPES.RUN_END,
      finalText: result.text,
    });
    opts.callbacks?.onEnd?.({
      runId,
      agentType: opts.agentType,
      seq: endSeq,
      finalText: result.text,
      persisted: true,
    });
    return { runId, result: result.text };
  } catch (error) {
    const errorMessage = `Claude Code execution failed: ${(error as Error).message || "Unknown error"}`;
    const errSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: RUNTIME_RUN_EVENT_TYPES.ERROR,
      error: errorMessage,
      fatal: true,
    });
    opts.callbacks?.onError?.({
      runId,
      agentType: opts.agentType,
      seq: errSeq,
      error: errorMessage,
      fatal: true,
    });
    return {
      runId,
      result: "",
      error: errorMessage,
    };
  }
};

export const shutdownSubagentEngineIntegrations = (): void => {
  shutdownClaudeCodeRuntime();
};
