/**
 * Post-completion "finishing up" HTML pass.
 *
 * When a `general` sub-agent finishes a turn that produced a substantial
 * report, we run one extra completion on a small, fast model and offer it
 * the exact same `html` tool the orchestrator uses. The model decides:
 * call `html` (with a self-contained document) when the result reads better
 * as a canvas, or answer in plain chat — i.e. emit no tool call — for quick
 * Q&A / short answers. When it calls the tool we execute it directly, so the
 * tool owns where the file is written (`~/.stella/outputs/html/<slug>.html`)
 * and how it surfaces as a canvas, identical to the orchestrator path.
 *
 * This replaces the old orchestrator-side reminder that nudged the model to
 * call `html` itself: the orchestrator still receives the agent's result,
 * but the canvas is now generated here, automatically, on a dedicated route.
 */

import { complete } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
} from "../../ai/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import type { ToolContext } from "../tools/types.js";
import { createHtmlTool } from "../tools/defs/html.js";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("agent-runtime.finish-html-pass");

/**
 * Subsidiary agent type used to resolve the route + honor a user model
 * override for this pass (see `getModelOverride`). Not a user-facing agent.
 *
 * The concrete model for this pass lives entirely in the stella-backend
 * managed catalog (the `html` internal config mapped to this agent type in
 * `convex/agent/model.ts` — Gemini Flash via the OpenRouter relay). The
 * desktop never hardcodes a model: it requests the opaque Stella default for
 * this agent type and the backend resolves it, so provider/model changes are
 * a one-line backend edit and honor a user override transparently.
 */
export const FINISH_HTML_AGENT_TYPE = "html_finish";

/** Skip the pass entirely for trivially short results — a one-liner is
 *  never worth a canvas, and running the model just adds latency. */
const MIN_RESULT_CHARS = 280;

const MAX_OUTPUT_TOKENS = 32_768;

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

/**
 * Run the finishing-up HTML pass. Best-effort: any failure (no credential,
 * model error, no tool call) resolves to `null` so the agent completes
 * normally without a canvas.
 */
export const runFinishHtmlPass = async (args: {
  stellaDataDir: string;
  route: ResolvedLlmRoute;
  description?: string;
  result: string;
  abortSignal?: AbortSignal;
}): Promise<FinishHtmlPassResult | null> => {
  const result = args.result.trim();
  if (result.length < MIN_RESULT_CHARS) return null;
  if (args.abortSignal?.aborted) return null;

  let apiKey: string | undefined;
  try {
    apiKey = (await args.route.getApiKey())?.trim() || undefined;
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) return null;

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

  // Offer the orchestrator's `html` tool verbatim — same name, description,
  // and JSON-schema args — so the model calls it exactly as the orchestrator
  // would, and the tool owns the file path + canvas surfacing.
  const tool = createHtmlTool({ stellaDataDir: args.stellaDataDir });
  const context: Context = {
    systemPrompt: FINISH_HTML_SYSTEM_PROMPT,
    messages,
    tools: [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Tool["parameters"],
      },
    ],
  };

  let response: AssistantMessage;
  try {
    response = await complete(args.route.model, context, {
      apiKey,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(args.abortSignal ? { signal: args.abortSignal } : {}),
    });
  } catch (error) {
    logger.debug("finish-html.completion.failed", {
      provider: args.route.model.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const toolCall = findHtmlToolCall(response);
  if (!toolCall) return null;
  if (args.abortSignal?.aborted) return null;

  try {
    // The html tool's execute only reads its args; the context is a required
    // parameter it ignores, so a minimal stub is sufficient.
    const toolContext: ToolContext = {
      conversationId: "",
      deviceId: "",
      requestId: `finish-html:${toolCall.id}`,
      stellaDataDir: args.stellaDataDir,
    };
    const toolResult = await tool.execute(toolCall.arguments, toolContext);
    if (toolResult.error) {
      logger.debug("finish-html.write.failed", { error: toolResult.error });
      return null;
    }
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
  } catch (error) {
    logger.debug("finish-html.write.threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};
