/**
 * Standalone HTML canvas generation.
 *
 * The orchestrator calls the `html` tool with a brief (what canvas to make)
 * plus, optionally, a scoped slice of context. The tool invokes this module to
 * turn that brief into a complete, self-contained HTML document, then writes it
 * to `~/.stella/outputs/html/<slug>.html` and surfaces it as a canvas.
 *
 * This generator ONLY generates. It does not decide whether a canvas is
 * warranted — that judgment lives entirely with the orchestrator, which calls
 * the tool when (and only when) it wants a canvas. When called, it renders,
 * full stop. There is no agent-lifecycle coupling and no auto-trigger.
 *
 * Routing mirrors the rest of the runtime (see `explore.ts`): it follows the
 * user's engine and model, not a forced managed model.
 *   - Claude Code engine → run through the user's Claude CLI as a text turn.
 *   - Default / Codex / BYOK → `resolveLlmRoute`, honoring a model override on
 *     the `html_finish` agent type. When the user has no override and is signed
 *     into Stella, this resolves to the backend `html` config (the same model
 *     HTML generation has always used). When no usable route or credential
 *     exists, generation quietly returns `null`.
 */

import { complete } from "../../ai/stream.js";
import type { AssistantMessage, Context, Message } from "../../ai/types.js";
import { resolveLlmRoute } from "../model-routing.js";
import type { StellaSiteConfig } from "../model-routing-stella.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import { getModelOverride } from "../preferences/local-preferences.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("agent-runtime.html-generation");

/**
 * Subsidiary agent type used to resolve the route + honor a user model
 * override for HTML generation. Not a user-facing agent.
 *
 * The value is kept as `html_finish` for backward compatibility: on the
 * default engine with no override this resolves to the stella-backend managed
 * `html` config (mapped to this agent type in `convex/agent/model.ts`). The
 * desktop never hardcodes the managed model — it requests the opaque Stella
 * default and the backend resolves it — so the model is unchanged from before.
 */
export const HTML_GENERATION_AGENT_TYPE = "html_finish";

const MAX_OUTPUT_TOKENS = 100_768;

export const HTML_GENERATION_SYSTEM_PROMPT = `You are Stella's HTML canvas generator. You receive a brief describing the canvas to make — its intent, the content/substance to present, and the desired feel — sometimes with a slice of relevant context. Your only job is to render it. You do NOT decide whether a canvas is warranted; you were called because one is wanted.

Produce exactly ONE complete, self-contained <!doctype html> document and output ONLY that document — no explanation, no commentary, no markdown code fences around it.

Faithfully present the substance from the brief and any provided context. Do not invent facts and do not summarize away detail — the canvas IS the detailed view.

Design rules (this is Stella — match the app):
- Use Cormorant Garamond for display/headings and Manrope for body text. Pull both from Google Fonts via <link> (the iframe has network).
- Quiet, elegant, Apple-like: generous whitespace, soft borders, gently rounded cards, restrained subtle shadows. No loud gradients, no decorative status dots, no rainbow accents.
- Neutral, theme-friendly palette: near-white background, near-black text, one calm accent at most. Looks at home in a calm desktop app.
- You may pull in CDN assets (Tailwind, Chart.js, D3, three.js, icon sets) via <link>, <script src>, or @import when they make the canvas better.`;

export type RunHtmlGenerationArgs = {
  stellaAppDir: string;
  stellaDataDir: string;
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  /** What canvas to make: intent + content/substance + desired feel. */
  brief: string;
  /** Short human-readable title for the canvas. */
  title: string;
  /** Optional scoped slice of conversation/turns the orchestrator attached. */
  scopedContext?: string;
  abortSignal?: AbortSignal;
};

const finalText = (message: AssistantMessage): string =>
  message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();

/** Strip a wrapping ```html / ``` fence if the model added one despite the
 *  instruction to emit raw HTML. */
const stripCodeFences = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\n?/, "");
  const withoutClose = withoutOpen.replace(/\n?```$/, "");
  return withoutClose.trim();
};

const buildUserText = (args: {
  brief: string;
  title: string;
  scopedContext?: string;
}): string => {
  const sections = [
    `Title: ${args.title}`,
    `\nBrief (what canvas to make):\n${args.brief}`,
  ];
  if (args.scopedContext && args.scopedContext.trim().length > 0) {
    sections.push(`\nRelevant context:\n${args.scopedContext.trim()}`);
  }
  return sections.join("\n");
};

/**
 * Generate a self-contained HTML document from a brief. Best-effort: any
 * failure (no usable route or credential, model error, empty output) resolves
 * to `null` so the caller can report the failure without crashing.
 */
export const generateHtmlDocument = async (
  args: RunHtmlGenerationArgs,
): Promise<string | null> => {
  const brief = args.brief.trim();
  if (brief.length === 0) return null;
  if (args.abortSignal?.aborted) return null;

  // Ride the user's BYOK pick when set for this generation route; undefined →
  // the backend-owned managed default for `html_finish` (the model HTML
  // generation has always used).
  const modelName = getModelOverride(
    args.stellaDataDir,
    HTML_GENERATION_AGENT_TYPE,
  );

  const userText = buildUserText({
    brief,
    title: args.title,
    ...(args.scopedContext ? { scopedContext: args.scopedContext } : {}),
  });
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];
  const context: Context = {
    systemPrompt: HTML_GENERATION_SYSTEM_PROMPT,
    messages,
    tools: [],
  };

  // Claude Code engine: run a one-shot text turn through the user's Claude CLI,
  // exactly like explore does. Engine detection reads the pref store (keyed by
  // stellaDataDir, same as the rest of the runtime).
  if (shouldUseClaudeCodeAgentRuntime({ stellaAppDir: args.stellaDataDir })) {
    try {
      const text = await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaDataDir,
        agentType: HTML_GENERATION_AGENT_TYPE,
        ...(modelName ? { stellaModel: modelName } : {}),
        context,
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      });
      if (args.abortSignal?.aborted) return null;
      const html = stripCodeFences(text);
      return html.length > 0 ? html : null;
    } catch (error) {
      logger.debug("html-generation.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Default / Codex / BYOK: resolve the route (honoring the BYOK override),
  // enrich with catalog metadata so a managed default routes to the right
  // gateway, then run one completion.
  let route;
  try {
    route = await withStellaModelCatalogMetadata({
      route: resolveLlmRoute({
        stellaAppDir: args.stellaDataDir,
        modelName,
        agentType: HTML_GENERATION_AGENT_TYPE,
        site: args.site,
      }),
      agentType: HTML_GENERATION_AGENT_TYPE,
      site: args.site,
      ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      ...(args.modelCatalogUpdatedAt != null
        ? { modelCatalogUpdatedAt: args.modelCatalogUpdatedAt }
        : {}),
      stellaDataDir: args.stellaDataDir,
    });
  } catch (error) {
    logger.debug("html-generation.route.unavailable", {
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

  let response: AssistantMessage;
  try {
    response = await complete(route.model, context, {
      apiKey,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(args.abortSignal ? { signal: args.abortSignal } : {}),
    });
  } catch (error) {
    logger.debug("html-generation.completion.failed", {
      provider: route.model.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (args.abortSignal?.aborted) return null;

  const html = stripCodeFences(finalText(response));
  return html.length > 0 ? html : null;
};
