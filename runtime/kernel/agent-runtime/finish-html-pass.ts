/**
 * Post-completion "finishing up" HTML pass.
 *
 * When a `general` sub-agent finishes a turn that produced a substantial
 * report, we run one extra completion that offers the exact same `html` tool
 * the orchestrator uses. The model decides: call `html` (with a self-contained
 * document) when the result reads better as a canvas, or answer in plain chat
 * — i.e. emit no tool call — for quick Q&A / short answers. When it calls the
 * tool we execute it directly, so the tool owns where the file is written
 * (`~/.stella/outputs/html/<slug>.html`) and how it surfaces as a canvas,
 * identical to the orchestrator path.
 *
 * Routing mirrors the rest of the runtime (see `explore.ts`): it follows the
 * user's engine and model, not a forced managed model.
 *   - Claude Code engine → run through the user's Claude CLI with the html tool.
 *   - Default / Codex / BYOK → `resolveLlmRoute`, honoring a model override that
 *     rides the general agent's pick (so a BYOK user's own provider/key is used).
 *     When the user has no override and is signed into Stella, this resolves to
 *     the backend `html` config (Gemini Flash via OpenRouter). When no usable
 *     route or credential exists, the pass quietly does nothing.
 *
 * We don't cost-optimize a user's own engine/provider — if they run Claude
 * Code, Codex, or BYOK, the pass uses that and the cost is theirs.
 */

import { complete } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
} from "../../ai/types.js";
import { resolveLlmRoute } from "../model-routing.js";
import type { StellaSiteConfig } from "../model-routing-stella.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import { getModelOverride } from "../preferences/local-preferences.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { createHtmlTool } from "../tools/defs/html.js";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("agent-runtime.finish-html-pass");

/**
 * Subsidiary agent type used to resolve the route + honor a user model
 * override for this pass (see `getModelOverride`). Not a user-facing agent.
 *
 * On the default engine with no override, this resolves to the stella-backend
 * managed `html` config (mapped to this agent type in `convex/agent/model.ts`
 * — Gemini Flash via the OpenRouter relay). The desktop never hardcodes the
 * managed model: it requests the opaque Stella default and the backend
 * resolves it, so provider/model changes are a one-line backend edit.
 */
export const FINISH_HTML_AGENT_TYPE = "html_finish";

/** Skip the pass entirely for trivially short results — a one-liner is
 *  never worth a canvas, and running the model just adds latency. */
const MIN_RESULT_CHARS = 280;

const MAX_OUTPUT_TOKENS = 100_768;

export const FINISH_HTML_SYSTEM_PROMPT = `You are the "finishing" pass for a Stella agent. You are given the agent's final report and the \`html\` tool, which writes a self-contained HTML document and shows it to the user as a canvas in the workspace panel.

Decide whether the result reads better as a rich visual canvas than as a plain chat reply:

- If a canvas genuinely helps — reports, plans, comparisons, breakdowns, structured findings, dashboards, mockups, anything dense or multi-section — call the \`html\` tool exactly once with a complete <!doctype html> document.
- If the work is a quick answer, a short confirmation, a simple Q&A, a yes/no, or anything that reads fine as one or two sentences — do NOT call the tool. Reply with a single short sentence instead. Most short answers do not need a canvas.

Design rules when you do render (this is Stella — match the app):
- Use Cormorant Garamond for display/headings and Manrope for body text. Pull both from Google Fonts via <link> (the iframe has network).
- Quiet, elegant, Apple-like: generous whitespace, soft borders, gently rounded cards, restrained subtle shadows. No loud gradients, no decorative status dots, no rainbow accents.
- Neutral, theme-friendly palette: near-white background, near-black text, one calm accent at most. Looks at home in a calm desktop app.
- Faithfully present the agent's actual content — do not invent facts, do not summarize away detail. The canvas IS the detailed view.
- You may pull in CDN assets (Tailwind, Chart.js, D3, icon sets) when they make the canvas better.`;

/**
 * Find the model's `html` tool call in a completion, or `null` when it
 * declined (answered in chat / called nothing). Exported for unit tests.
 */
export const findHtmlToolCall = (message: AssistantMessage): ToolCall | null => {
  for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "html") {
      return part;
    }
  }
  return null;
};

export type FinishHtmlPassResult = {
  filePath: string;
  slug: string;
  title: string;
  fileChanges: FileChangeRecord[];
};

/** Lift the `html` tool's result into a pass result, or `null` if it didn't
 *  produce a usable file. Exported for unit tests. */
export const extractFinishHtmlResult = (
  toolResult: ToolResult,
): FinishHtmlPassResult | null => {
  if (toolResult.error) return null;
  const details = (toolResult.details ?? {}) as {
    filePath?: unknown;
    slug?: unknown;
    title?: unknown;
  };
  const filePath =
    typeof details.filePath === "string" ? details.filePath : null;
  if (!filePath) return null;
  return {
    filePath,
    slug: typeof details.slug === "string" ? details.slug : "",
    title: typeof details.title === "string" ? details.title : "Canvas",
    fileChanges: toolResult.fileChanges ?? [],
  };
};

export type RunFinishHtmlPassArgs = {
  stellaAppDir: string;
  stellaDataDir: string;
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  description?: string;
  result: string;
  abortSignal?: AbortSignal;
};

/**
 * Run the finishing-up HTML pass. Best-effort: any failure (no usable route or
 * credential, model error, no tool call) resolves to `null` so the agent
 * completes normally without a canvas.
 */
export const runFinishHtmlPass = async (
  args: RunFinishHtmlPassArgs,
): Promise<FinishHtmlPassResult | null> => {
  const result = args.result.trim();
  if (result.length < MIN_RESULT_CHARS) return null;
  if (args.abortSignal?.aborted) return null;

  // Ride the user's BYOK pick: prefer an explicit override for this pass, then
  // the general agent's model (whose work we're finishing). Undefined → the
  // backend-owned managed default for `html_finish`.
  const modelName =
    getModelOverride(args.stellaDataDir, FINISH_HTML_AGENT_TYPE) ??
    getModelOverride(args.stellaDataDir, AGENT_IDS.GENERAL);

  const tool = createHtmlTool({ stellaDataDir: args.stellaDataDir });
  const toolContext: ToolContext = {
    conversationId: "",
    deviceId: "",
    requestId: `finish-html:${Date.now().toString(36)}`,
    stellaDataDir: args.stellaDataDir,
  };
  const toolSchema: Tool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Tool["parameters"],
  };
  const userText = args.description
    ? `Task: ${args.description}\n\nAgent's finished report:\n${result}`
    : `Agent's finished report:\n${result}`;
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];

  // Claude Code engine: run the pass through the user's Claude CLI with the
  // html tool offered, exactly like explore does. Engine detection reads the
  // pref store (keyed by stellaDataDir, same as the rest of the runtime).
  if (shouldUseClaudeCodeAgentRuntime({ stellaAppDir: args.stellaDataDir })) {
    let captured: FinishHtmlPassResult | null = null;
    try {
      await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaAppDir,
        agentType: FINISH_HTML_AGENT_TYPE,
        ...(modelName ? { stellaModel: modelName } : {}),
        context: {
          systemPrompt: FINISH_HTML_SYSTEM_PROMPT,
          messages,
          tools: [toolSchema],
        },
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          if (toolName !== tool.name) {
            return {
              error: `Tool ${toolName} is not available to the finishing pass.`,
            };
          }
          const toolResult = await tool.execute(toolArgs, toolContext);
          const extracted = extractFinishHtmlResult(toolResult);
          if (extracted) captured = extracted;
          return toolResult;
        },
      });
    } catch (error) {
      logger.debug("finish-html.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (args.abortSignal?.aborted) return null;
    return captured;
  }

  // Default / Codex / BYOK: resolve the route (honoring the BYOK override),
  // enrich with catalog metadata so a managed default routes to the right
  // gateway, then offer the html tool in one completion.
  let route;
  try {
    route = await withStellaModelCatalogMetadata({
      route: resolveLlmRoute({
        stellaAppDir: args.stellaDataDir,
        modelName,
        agentType: FINISH_HTML_AGENT_TYPE,
        site: args.site,
      }),
      agentType: FINISH_HTML_AGENT_TYPE,
      site: args.site,
      ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      ...(args.modelCatalogUpdatedAt != null
        ? { modelCatalogUpdatedAt: args.modelCatalogUpdatedAt }
        : {}),
      stellaDataDir: args.stellaDataDir,
    });
  } catch (error) {
    logger.debug("finish-html.route.unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let apiKey: string | undefined;
  try {
    apiKey = (await route.getApiKey())?.trim() || undefined;
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) return null;

  const context: Context = {
    systemPrompt: FINISH_HTML_SYSTEM_PROMPT,
    messages,
    tools: [toolSchema],
  };

  let response: AssistantMessage;
  try {
    response = await complete(route.model, context, {
      apiKey,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(args.abortSignal ? { signal: args.abortSignal } : {}),
    });
  } catch (error) {
    logger.debug("finish-html.completion.failed", {
      provider: route.model.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const toolCall = findHtmlToolCall(response);
  if (!toolCall) return null;
  if (args.abortSignal?.aborted) return null;

  try {
    const toolResult = await tool.execute(toolCall.arguments, toolContext);
    if (toolResult.error) {
      logger.debug("finish-html.write.failed", { error: toolResult.error });
      return null;
    }
    return extractFinishHtmlResult(toolResult);
  } catch (error) {
    logger.debug("finish-html.write.threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};
