/**
 * Background Orchestrator memory review.
 *
 * Fires after the Orchestrator finalizes a successful turn whenever the
 * memory-review user-turn counter has reached the threshold (default 20).
 * The review is a one-shot, fire-and-forget completion that:
 *
 *   1. Sees the recent Orchestrator transcript verbatim.
 *   2. Has ONLY the `Memory` tool available (no spawn_agent, etc.).
 *   3. Loops up to MAX_ITERATIONS turns, executing any returned Memory tool
 *      calls against the shared MemoryStore.
 *   4. Stops when the model emits no tool calls (typically after responding
 *      "Nothing to save." per the prompt).
 *
 * Errors are swallowed - this is best-effort; user already has their reply
 * by the time this fires.
 */

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { createMemoryTool } from "../tools/defs/memory.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";

const logger = createRuntimeLogger("agent-runtime.memory-review");

export const MEMORY_REVIEW_TURN_THRESHOLD = 20;

const MAX_ITERATIONS = 8;

const MEMORY_REVIEW_SYSTEM_PROMPT = [
  "You are a background memory review pass for the Stella Orchestrator. You see the recent conversation between the user and the Orchestrator.",
  "",
  "Your only job is to update durable memory if the user has revealed something worth remembering.",
  "",
  "Save to memory ONLY if the user has revealed:",
  "  1. Identity facts (name, role, timezone, preferences they expressed verbally).",
  "  2. Persistent expectations about how Stella should behave.",
  "  3. Cross-task patterns (\"user always wants X format\", \"avoid Y\").",
  "",
  "Use action=\"add\" with target=\"user\" for identity / preferences / expectations.",
  "Use action=\"add\" with target=\"memory\" for cross-task patterns.",
  "Use action=\"replace\" or action=\"remove\" if existing entries are now wrong or stale.",
  "",
  "Do NOT save:",
  "  - Specific task content (the Dream agent folds that into state/memories/MEMORY.md).",
  "  - One-off requests.",
  "  - Environment, tool, or skill facts (the General agent writes those to state/skills/ or state/knowledge/).",
  "",
  "If nothing meets the bar, respond exactly \"Nothing to save.\" and stop. Do not explain.",
].join("\n");

const MEMORY_REVIEW_USER_PROMPT_PREFIX =
  "Review the recent conversation below and act according to your instructions.\n\n";

const buildMemorySnapshotBlock = (args: {
  store: RuntimeStore;
  target: "memory" | "user";
}): string | null => {
  const block = args.store.memoryStore.formatForSystemPrompt(args.target)?.trim();
  if (!block) {
    return null;
  }
  return `<memory_snapshot target="${args.target}">\n${block}\n</memory_snapshot>`;
};

export const buildMemoryReviewSystemPrompt = (store: RuntimeStore): string => {
  // Freeze a fresh snapshot for the review pass so replace/remove decisions are
  // grounded in the current durable memory state.
  store.memoryStore.loadSnapshot();
  const currentUser = buildMemorySnapshotBlock({ store, target: "user" });
  const currentMemory = buildMemorySnapshotBlock({ store, target: "memory" });
  const currentSnapshot = [currentUser, currentMemory].filter(
    (entry): entry is string => entry != null,
  );
  if (currentSnapshot.length === 0) {
    return MEMORY_REVIEW_SYSTEM_PROMPT;
  }
  return [
    MEMORY_REVIEW_SYSTEM_PROMPT,
    "Current durable memory snapshot for this review:",
    ...currentSnapshot,
  ].join("\n\n");
};

const buildMemoryTool = (memoryStore: MemoryStore): Tool => {
  // The MemoryStore is required to construct the def, but we only need its
  // metadata here — execution is routed through `dispatchLocalTool` separately.
  const def = createMemoryTool({ memoryStore });
  return {
    name: def.name,
    description: def.description,
    // The Tool.parameters slot is a TSchema in the type system; the runtime
    // only needs JSON-Schema-shaped data, matching how tool-adapters.ts casts.
    parameters: def.parameters as Tool["parameters"],
  };
};

const formatTextContent = (parts: AssistantMessage["content"]): string =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return "";
      return "";
    })
    .join("")
    .trim();

const summarizeMessageForTranscript = (msg: AgentMessage): string | null => {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      return text ? `[User]\n${text}` : null;
    }
    const text = msg.content
      .map((part) => (part.type === "text" ? part.text : `[Image: ${part.mimeType}]`))
      .join("\n")
      .trim();
    return text ? `[User]\n${text}` : null;
  }
  if (msg.role === "assistant") {
    const text = formatTextContent(msg.content);
    return text ? `[Assistant]\n${text}` : null;
  }
  return null;
};

const buildTranscript = (messages: AgentMessage[]): string =>
  messages
    .map(summarizeMessageForTranscript)
    .filter((entry): entry is string => entry != null)
    .join("\n\n");

const toToolResultMessage = (
  toolCall: ToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  isError,
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const runReview = async (args: {
  conversationId: string;
  stellaRoot: string;
  messagesSnapshot: AgentMessage[];
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
}): Promise<void> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: args.stellaRoot,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : (await args.resolvedLlm.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    logger.debug("memory-review.skipped.no-api-key");
    return;
  }

  const transcript = buildTranscript(args.messagesSnapshot);
  if (!transcript) {
    logger.debug("memory-review.skipped.empty-transcript");
    return;
  }

  const reviewSystemPrompt = buildMemoryReviewSystemPrompt(args.store);
  const memoryTool = buildMemoryTool(args.store.memoryStore);
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${MEMORY_REVIEW_USER_PROMPT_PREFIX}${transcript}`,
        },
      ],
      timestamp: Date.now(),
    },
  ];

  let totalToolCalls = 0;

  if (useClaudeCode) {
    try {
      const finalText = await runClaudeCodeAgentTextCompletion({
        stellaRoot: args.stellaRoot,
        agentType: "memory_review",
        context: {
          systemPrompt: reviewSystemPrompt,
          messages,
          tools: [memoryTool],
        },
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          totalToolCalls += 1;
          const dispatch = await dispatchLocalTool(toolName, toolArgs, {
            conversationId: args.conversationId,
            store: { memoryStore: args.store.memoryStore },
          });
          if (!dispatch.handled) {
            return {
              error: JSON.stringify({
                success: false,
                error: `Tool ${toolName} not available in memory review (only Memory is exposed).`,
              }),
            };
          }
          return { result: dispatch.text };
        },
      });
      logger.debug("memory-review.completed", {
        iterations: 1,
        toolCalls: totalToolCalls,
        finalText: finalText.slice(0, 80),
      });
    } catch (error) {
      logger.debug("memory-review.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const context: Context = {
      systemPrompt: reviewSystemPrompt,
      messages,
      tools: [memoryTool],
    };

    let response: AssistantMessage;
    try {
      response = await completeSimple(args.resolvedLlm.model, context, {
        apiKey,
      });
    } catch (error) {
      logger.debug("memory-review.completeSimple.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    messages.push(response);

    const toolCalls = response.content.filter(
      (part): part is ToolCall => part.type === "toolCall",
    );

    if (toolCalls.length === 0) {
      logger.debug("memory-review.completed", {
        iterations: iteration + 1,
        toolCalls: totalToolCalls,
        finalText: readAssistantText(response).slice(0, 80),
      });
      return;
    }

    for (const toolCall of toolCalls) {
      totalToolCalls += 1;
      try {
        const dispatch = await dispatchLocalTool(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>,
          {
            conversationId: args.conversationId,
            store: { memoryStore: args.store.memoryStore },
          },
        );
        if (!dispatch.handled) {
          messages.push(
            toToolResultMessage(
              toolCall,
              JSON.stringify({
                success: false,
                error: `Tool ${toolCall.name} not available in memory review (only Memory is exposed).`,
              }),
              true,
            ),
          );
          continue;
        }
        messages.push(toToolResultMessage(toolCall, dispatch.text, false));
      } catch (error) {
        messages.push(
          toToolResultMessage(
            toolCall,
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            true,
          ),
        );
      }
    }
  }

  logger.debug("memory-review.iteration-cap", {
    iterations: MAX_ITERATIONS,
    toolCalls: totalToolCalls,
  });
};

/**
 * Fire-and-forget background memory review. Never throws; never blocks the
 * caller. Resets the user-turn counter immediately so a fast follow-up turn
 * does not double-trigger.
 */
export const spawnMemoryReview = (args: {
  conversationId: string;
  stellaRoot: string;
  messagesSnapshot: AgentMessage[];
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
}): void => {
  try {
    args.store.resetUserTurnsSinceMemoryReview(args.conversationId);
  } catch {
    // counter reset is best-effort
  }
  void runReview(args).catch((error) => {
    logger.debug("memory-review.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
