/**
 * Explore - per-task scout that reads state/ before a General agent task runs.
 *
 * Stateless one-shot helper. Not a real subagent task: no SQLite thread, no
 * runtime_threads row, no run-events emitted, no UI surface. The result is
 * inlined into the General agent's first user message as an
 * <explore_findings>...</explore_findings> block.
 *
 * The Explore agent has only Read and Grep available. It is constrained by
 * its system prompt (runtime/extensions/stella-runtime/agents/explore.md) to
 * `state/` and to a strict JSON output shape.
 *
 * Failures are graceful: a 30-second timeout, a missing model route, or any
 * tool/LLM error all produce an `<explore_findings status="unavailable">`
 * block so the General agent still gets a clean prompt.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { completeSimple } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../../ai/types.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import { grepTool } from "../tools/defs/grep.js";
import { readTool } from "../tools/defs/read.js";
import { resolveLlmRoute } from "../model-routing.js";
import { resolveAgent } from "../runner/context.js";
import { createRunnerSiteConfig } from "../runner/model-selection.js";
import { getExploreModel } from "../preferences/local-preferences.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunnerContext } from "../runner/types.js";

const logger = createRuntimeLogger("agent-runtime.explore");

const EXPLORE_TIMEOUT_MS = 30_000;
const MAX_TOOL_ITERATIONS = 8;
const EXPLORE_TOOL_NAMES = ["Read", "Grep"] as const;
const STATE_DIR_NAME = "state";

export const FALLBACK_FINDINGS = `<explore_findings status="unavailable">
{"relevant": [], "maybe": [], "nothing_found_for": []}
</explore_findings>`;

const wrapFindings = (json: string): string =>
  `<explore_findings>\n${json}\n</explore_findings>`;

const EXPLORE_TOOL_DEFS = { Read: readTool, Grep: grepTool } as const;

const buildExploreTools = (): Tool[] =>
  EXPLORE_TOOL_NAMES.map((name) => {
    const def = EXPLORE_TOOL_DEFS[name];
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters as Tool["parameters"],
    };
  });

const normalizeForComparison = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

const isWithinRoot = (candidate: string, root: string): boolean => {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(root);
  return normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
};

const maybeRealPath = async (candidate: string): Promise<string> => {
  try {
    return await fs.realpath(candidate);
  } catch {
    return candidate;
  }
};

const resolveStateScopedPath = async (
  candidate: string,
  stellaRoot: string,
): Promise<string | null> => {
  const stateRoot = path.resolve(stellaRoot, STATE_DIR_NAME);
  const resolvedCandidate = path.resolve(
    path.isAbsolute(candidate) ? candidate : path.join(stellaRoot, candidate),
  );
  const [realStateRoot, realCandidate] = await Promise.all([
    maybeRealPath(stateRoot),
    maybeRealPath(resolvedCandidate),
  ]);
  return isWithinRoot(realCandidate, realStateRoot) ? resolvedCandidate : null;
};

export const sanitizeExploreToolArgs = async (
  toolName: typeof EXPLORE_TOOL_NAMES[number],
  toolArgs: Record<string, unknown>,
  stellaRoot: string,
): Promise<
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }
> => {
  if (!stellaRoot.trim()) {
    return {
      ok: false,
      error: "Explore requires a Stella root so it can stay inside state/.",
    };
  }

  if (toolName === "Read") {
    const rawPath = typeof toolArgs.file_path === "string" ? toolArgs.file_path.trim() : "";
    if (!rawPath) {
      return { ok: false, error: "Read requires a non-empty file_path." };
    }
    const safePath = await resolveStateScopedPath(rawPath, stellaRoot);
    if (!safePath) {
      return {
        ok: false,
        error: `Explore can only read paths inside ${STATE_DIR_NAME}/.`,
      };
    }
    return {
      ok: true,
      args: {
        ...toolArgs,
        file_path: safePath,
      },
    };
  }

  const rawPath = typeof toolArgs.path === "string" && toolArgs.path.trim()
    ? toolArgs.path.trim()
    : STATE_DIR_NAME;
  const safePath = await resolveStateScopedPath(rawPath, stellaRoot);
  if (!safePath) {
    return {
      ok: false,
      error: `Explore can only search inside ${STATE_DIR_NAME}/.`,
    };
  }
  return {
    ok: true,
    args: {
      ...toolArgs,
      path: safePath,
    },
  };
};

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

const stringifyToolResult = (result: { result?: unknown; error?: string }): string => {
  if (result.error) {
    return `Error: ${result.error}`;
  }
  if (typeof result.result === "string") {
    return result.result;
  }
  if (result.result == null) {
    return "";
  }
  try {
    return JSON.stringify(result.result);
  } catch {
    return String(result.result);
  }
};

const finalText = (message: AssistantMessage): string =>
  message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> => {
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
  }
};

export type RunExploreArgs = {
  context: RunnerContext;
  conversationId: string;
  taskDescription: string;
  taskPrompt: string;
  signal?: AbortSignal;
};

/**
 * Run the Explore agent for a single task and return the wrapped
 * <explore_findings>...</explore_findings> block to prepend to the General
 * agent's first user message. Always returns a usable block; never throws.
 */
export const runExplore = async (args: RunExploreArgs): Promise<string> => {
  const { context, conversationId, taskDescription, taskPrompt, signal } = args;
  if (signal?.aborted) {
    logger.debug("explore.skipped.aborted-before-start");
    return FALLBACK_FINDINGS;
  }

  let exploreSystemPrompt: string;
  try {
    const exploreAgent = resolveAgent(context, AGENT_IDS.EXPLORE);
    const prompt = exploreAgent?.systemPrompt?.trim();
    if (!prompt) {
      logger.debug("explore.skipped.no-system-prompt");
      return FALLBACK_FINDINGS;
    }
    exploreSystemPrompt = prompt;
  } catch (error) {
    logger.debug("explore.skipped.resolve-agent-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return FALLBACK_FINDINGS;
  }

  let resolvedLlm;
  try {
    const modelName = getExploreModel(context.stellaRoot);
    resolvedLlm = resolveLlmRoute({
      stellaRoot: context.stellaRoot,
      modelName,
      agentType: AGENT_IDS.EXPLORE,
      site: createRunnerSiteConfig(context),
    });
  } catch (error) {
    logger.debug("explore.skipped.no-llm-route", {
      error: error instanceof Error ? error.message : String(error),
    });
    return FALLBACK_FINDINGS;
  }

  const apiKey = (await resolvedLlm.getApiKey())?.trim();
  if (!apiKey) {
    logger.debug("explore.skipped.no-api-key");
    return FALLBACK_FINDINGS;
  }

  const tools = buildExploreTools();
  const userText = taskDescription.trim()
    ? `Task: ${taskDescription.trim()}\n\n${taskPrompt.trim()}`
    : taskPrompt.trim();

  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];

  const abortController = new AbortController();
  const handleAbort = () => abortController.abort(signal?.reason);
  signal?.addEventListener("abort", handleAbort, { once: true });

  const innerLoop = async (): Promise<string> => {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const ctx: Context = {
        systemPrompt: exploreSystemPrompt,
        messages,
        tools,
      };

      let response: AssistantMessage;
      try {
        response = await completeSimple(resolvedLlm.model, ctx, {
          apiKey,
          signal: abortController.signal,
        });
      } catch (error) {
        logger.debug("explore.completeSimple.failed", {
          iteration,
          error: error instanceof Error ? error.message : String(error),
        });
        return FALLBACK_FINDINGS;
      }

      messages.push(response);

      const toolCalls = response.content.filter(
        (part): part is ToolCall => part.type === "toolCall",
      );

      if (toolCalls.length === 0) {
        const text = finalText(response);
        if (!text) {
          logger.debug("explore.empty-final-response");
          return FALLBACK_FINDINGS;
        }
        return wrapFindings(text);
      }

      for (const toolCall of toolCalls) {
        if (!EXPLORE_TOOL_NAMES.includes(toolCall.name as typeof EXPLORE_TOOL_NAMES[number])) {
          messages.push(
            toToolResultMessage(
              toolCall,
              `Error: tool ${toolCall.name} is not available to Explore. Only Read and Grep are exposed.`,
              true,
            ),
          );
          continue;
        }
        try {
          const sanitized = await sanitizeExploreToolArgs(
            toolCall.name as typeof EXPLORE_TOOL_NAMES[number],
            (toolCall.arguments as Record<string, unknown>) ?? {},
            context.stellaRoot,
          );
          if (!sanitized.ok) {
            messages.push(
              toToolResultMessage(toolCall, `Error: ${sanitized.error}`, true),
            );
            continue;
          }
          const result = await context.toolHost.executeTool(
            toolCall.name,
            sanitized.args,
            {
              conversationId,
              deviceId: context.deviceId,
              requestId: `explore-${Date.now()}`,
              agentType: AGENT_IDS.EXPLORE,
              stellaRoot: context.stellaRoot,
            },
            abortController.signal,
          );
          messages.push(
            toToolResultMessage(
              toolCall,
              stringifyToolResult(result),
              Boolean(result.error),
            ),
          );
        } catch (error) {
          messages.push(
            toToolResultMessage(
              toolCall,
              `Error: ${error instanceof Error ? error.message : String(error)}`,
              true,
            ),
          );
        }
      }
    }

    logger.debug("explore.iteration-cap", { iterations: MAX_TOOL_ITERATIONS });
    return FALLBACK_FINDINGS;
  };

  try {
    return await withTimeout(innerLoop(), EXPLORE_TIMEOUT_MS, abortController);
  } catch (error) {
    logger.debug("explore.timeout-or-error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return FALLBACK_FINDINGS;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
  }
};
