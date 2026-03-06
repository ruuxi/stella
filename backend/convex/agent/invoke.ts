import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { stepCountIs } from "ai";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "../tools/index";
import { requireConversationOwnerAction } from "../auth";
import { jsonSchemaValidator, jsonValueValidator } from "../shared_validators";
import { normalizeOptionalInt } from "../lib/number_utils";
import { stableStringify, extractJsonBlock } from "../lib/json";
import { validateAgainstSchema } from "../lib/validator";
import { scrubProviderTerms, scrubValue } from "../lib/provider_redaction";
import { resolveModelConfig, resolveFallbackConfig } from "./model_resolver";
import { streamTextWithFailover } from "./model_execution";
import { PREFERRED_BROWSER_KEY } from "../data/preferences";
import { BROWSER_AGENT_SAFARI_DENIED_REASON } from "../lib/agent_constants";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const MAX_RAW_TEXT = 60_000;
const MAX_SCHEMA_CHARS = 40_000;
const MAX_INPUT_CHARS = 40_000;

const truncate = (value: string, max = MAX_RAW_TEXT) =>
  value.length <= max ? value : `${value.slice(0, max)}\n\n... (truncated)`;


type AgentInvokeResult =
  | {
      ok: false;
      reason: string;
      rawText: string;
    }
  | {
      ok: true;
      rawText: string;
      outputJson: string;
    };

export const invoke = internalAction({
  args: {
    agentType: v.string(),
    mode: v.optional(v.string()),
    prompt: v.optional(v.string()),
    input: v.optional(jsonValueValidator),
    resultSchema: v.optional(jsonSchemaValidator),
    maxSteps: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
    userMessageId: v.optional(v.id("events")),
    targetDeviceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AgentInvokeResult> => {
    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});

    let ownerId: string | undefined = undefined;
    if (args.conversationId) {
      const convo = await requireConversationOwnerAction(ctx, args.conversationId);
      ownerId = convo.ownerId;
    }

    if (args.agentType === "browser" && ownerId) {
      const preferredBrowser = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
        ownerId,
        key: PREFERRED_BROWSER_KEY,
      });
      if (preferredBrowser?.trim().toLowerCase() === "safari") {
        return {
          ok: false,
          reason: BROWSER_AGENT_SAFARI_DENIED_REASON,
          rawText: BROWSER_AGENT_SAFARI_DENIED_REASON,
        };
      }
    }

    const promptBuild = await buildSystemPrompt(ctx, args.agentType, { ownerId });

    const tools = createTools(
      ctx,
      {
        agentType: args.agentType,
        toolsAllowlist: promptBuild.toolsAllowlist,
        maxTaskDepth: Math.min(promptBuild.maxTaskDepth, 2),
        ownerId,
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
      },
    );

    const schemaText = truncate(
      stableStringify(args.resultSchema ?? { type: "object" }),
      MAX_SCHEMA_CHARS,
    );
    const inputText = truncate(stableStringify(args.input ?? {}), MAX_INPUT_CHARS);
    const mode = args.mode?.trim();
    const prompt = args.prompt?.trim();

    const invocationInstructions = [
      "You are being invoked as a bounded agent tool.",
      "Return JSON only. Do not include markdown or explanation outside JSON.",
      "Never mention providers, model identifiers, or internal infrastructure.",
      "If you cannot comply, return {\"ok\":false,\"reason\":\"...\"}.",
    ].join("\n");

    const userBlocks = [
      mode ? `Mode:\n${mode}` : null,
      prompt ? `Task:\n${prompt}` : null,
      `Input (JSON):\n${inputText}`,
      `Result schema (JSON Schema subset):\n${schemaText}`,
      "Return a single JSON object that matches the schema.",
    ].filter((block): block is string => Boolean(block));

    const maxSteps = normalizeOptionalInt({
      value: args.maxSteps,
      defaultValue: 20,
      min: 1,
      max: 20,
    });

    let rawText = "";
    try {
      const invokeSharedArgs = {
        system: `${promptBuild.systemPrompt}\n\n${invocationInstructions}`.trim(),
        tools,
        stopWhen: stepCountIs(maxSteps),
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: userBlocks.join("\n\n") }],
          },
        ],
      };

      const resolvedConfig = await resolveModelConfig(ctx, args.agentType, ownerId);
      const fallbackConfig = await resolveFallbackConfig(ctx, args.agentType, ownerId);
      const result = await streamTextWithFailover({
        resolvedConfig,
        fallbackConfig: fallbackConfig ?? undefined,
        sharedArgs: invokeSharedArgs as Record<string, unknown>,
      });

      rawText = scrubProviderTerms(truncate(await result.text));
    } catch (error) {
      return {
        ok: false as const,
        reason: scrubProviderTerms(
          (error as Error)?.message || "agent.invoke failed to run the model.",
        ),
        rawText: "",
      };
    }

    const jsonBlock = extractJsonBlock(rawText);
    if (!jsonBlock) {
      return {
        ok: false as const,
        reason: "agent.invoke did not return valid JSON.",
        rawText,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBlock);
    } catch (error) {
      return {
        ok: false as const,
        reason: `Failed to parse JSON: ${(error as Error).message}`,
        rawText,
      };
    }

    const scrubbed = scrubValue(parsed);
    const validation = validateAgainstSchema(
      args.resultSchema as Record<string, unknown> | undefined,
      scrubbed,
    );
    if (!validation.ok) {
      return {
        ok: false as const,
        reason: validation.reason,
        rawText,
      };
    }

    return {
      ok: true as const,
      rawText,
      outputJson: stableStringify(scrubbed),
    };
  },
});
