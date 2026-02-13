import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { streamText, stepCountIs } from "ai";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "../tools/index";
import { resolveModelConfig } from "./model_resolver";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwner } from "../auth";
import { jsonSchemaValidator, jsonValueValidator } from "../shared_validators";

const MAX_RAW_TEXT = 60_000;
const MAX_SCHEMA_CHARS = 40_000;
const MAX_INPUT_CHARS = 40_000;
const PREFERRED_BROWSER_KEY = "preferred_browser";
const BROWSER_AGENT_SAFARI_DENIED_REASON =
  "Browser Agent is unavailable when the selected browser is Safari. Use a Chromium-based browser for browser automation.";

const truncate = (value: string, max = MAX_RAW_TEXT) =>
  value.length <= max ? value : `${value.slice(0, max)}\n\n... (truncated)`;

const scrubProviderTerms = (value: string) =>
  value
    .replace(/openai|anthropic|claude|gpt-?\d*|gemini|llama|mistral/gi, "model")
    .replace(/provider|model\s+id|model\s+name/gi, "model");

const scrubValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return scrubProviderTerms(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      scrubValue(v),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
};

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const stringify = (input: unknown): string => {
    if (input === null || typeof input !== "object") {
      return JSON.stringify(input);
    }
    if (seen.has(input as object)) {
      return JSON.stringify("[Circular]");
    }
    seen.add(input as object);
    if (Array.isArray(input)) {
      return `[${input.map((item) => stringify(item)).join(",")}]`;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const body = keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`);
    return `{${body.join(",")}}`;
  };
  return stringify(value);
};

const extractJsonBlock = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const startCandidates = [firstObject, firstArray].filter((idx) => idx >= 0);
  if (startCandidates.length === 0) {
    return null;
  }
  const start = Math.min(...startCandidates);
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayEnd = trimmed.lastIndexOf("]");
  const endCandidates = [objectEnd, arrayEnd].filter((idx) => idx >= start);
  if (endCandidates.length === 0) {
    return null;
  }
  const end = Math.max(...endCandidates);
  const candidate = trimmed.slice(start, end + 1).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
};

type JsonSchema = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const agentInvokeResultValidator = v.union(
  v.object({
    ok: v.literal(false),
    reason: v.string(),
    rawText: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    rawText: v.string(),
    outputJson: v.string(),
  }),
);

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

const validateAgainstSchema = (
  schema: JsonSchema | undefined,
  value: unknown,
): { ok: true } | { ok: false; reason: string } => {
  if (!schema) {
    return { ok: true };
  }
  const schemaType = typeof schema.type === "string" ? schema.type : undefined;

  if (schemaType === "object") {
    if (!isPlainObject(value)) {
      return { ok: false, reason: "Result must be a JSON object." };
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        return { ok: false, reason: `Missing required field: ${key}` };
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const propType =
        propSchema && typeof propSchema === "object" && typeof (propSchema as any).type === "string"
          ? String((propSchema as any).type)
          : undefined;
      const propValue = (value as Record<string, unknown>)[key];
      if (propType === "string" && typeof propValue !== "string") {
        return { ok: false, reason: `Field ${key} must be a string.` };
      }
      if (propType === "number" && typeof propValue !== "number") {
        return { ok: false, reason: `Field ${key} must be a number.` };
      }
      if (propType === "boolean" && typeof propValue !== "boolean") {
        return { ok: false, reason: `Field ${key} must be a boolean.` };
      }
      if (propType === "array" && !Array.isArray(propValue)) {
        return { ok: false, reason: `Field ${key} must be an array.` };
      }
      if (
        propSchema &&
        typeof propSchema === "object" &&
        Array.isArray((propSchema as any).enum) &&
        !(propSchema as any).enum.includes(propValue)
      ) {
        return { ok: false, reason: `Field ${key} must be one of the allowed enum values.` };
      }
      if (
        propSchema &&
        typeof propSchema === "object" &&
        typeof (propSchema as any).maxLength === "number" &&
        typeof propValue === "string" &&
        propValue.length > (propSchema as any).maxLength
      ) {
        return { ok: false, reason: `Field ${key} exceeds maxLength.` };
      }
      if (
        propSchema &&
        typeof propSchema === "object" &&
        typeof (propSchema as any).maxItems === "number" &&
        Array.isArray(propValue) &&
        propValue.length > (propSchema as any).maxItems
      ) {
        return { ok: false, reason: `Field ${key} exceeds maxItems.` };
      }
    }
    return { ok: true };
  }

  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      return { ok: false, reason: "Result must be a JSON array." };
    }
    const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
    if (typeof maxItems === "number" && value.length > maxItems) {
      return { ok: false, reason: `Array exceeds maxItems (${maxItems}).` };
    }
    return { ok: true };
  }

  if (schemaType === "string" && typeof value !== "string") {
    return { ok: false, reason: "Result must be a string." };
  }
  if (schemaType === "number" && typeof value !== "number") {
    return { ok: false, reason: "Result must be a number." };
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    return { ok: false, reason: "Result must be a boolean." };
  }

  return { ok: true };
};

const coerceDeviceContext = async (
  ctx: Parameters<typeof createTools>[0],
  args: {
    conversationId?: Id<"conversations">;
    userMessageId?: Id<"events">;
    targetDeviceId?: string;
  },
) => {
  const conversationId = args.conversationId;
  const userMessageId = args.userMessageId;
  let targetDeviceId = args.targetDeviceId;

  if (!targetDeviceId && userMessageId) {
    try {
      const userEvent = await ctx.runQuery(internal.events.getById, { id: userMessageId });
      if (userEvent?.deviceId) {
        targetDeviceId = userEvent.deviceId;
      }
    } catch {
      // Ignore lookup failures.
    }
  }

  if (!conversationId || !userMessageId || !targetDeviceId) {
    return null;
  }

  return { conversationId, userMessageId, targetDeviceId };
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
  returns: agentInvokeResultValidator,
  handler: async (ctx, args): Promise<AgentInvokeResult> => {
    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});

    let ownerId: string | undefined = undefined;
    if (args.conversationId) {
      const convo = await requireConversationOwner(ctx, args.conversationId);
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

    const deviceContext = await coerceDeviceContext(ctx, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
    });

    const tools = deviceContext
      ? createTools(
          ctx,
          {
            ...deviceContext,
            agentType: args.agentType,
            sourceDeviceId: deviceContext.targetDeviceId,
          },
          {
            agentType: args.agentType,
            toolsAllowlist: promptBuild.toolsAllowlist,
            maxTaskDepth: Math.min(promptBuild.maxTaskDepth, 2),
            ownerId,
            conversationId: args.conversationId,
          },
        )
      : undefined;

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

    const maxSteps = Math.min(Math.max(Math.floor(args.maxSteps ?? 20), 1), 20);

    let rawText = "";
    try {
      const resolvedConfig = await resolveModelConfig(ctx, args.agentType, ownerId);
      const result = await streamText({
        ...resolvedConfig,
        system: `${promptBuild.systemPrompt}\n\n${invocationInstructions}`.trim(),
        tools,
        stopWhen: stepCountIs(maxSteps),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userBlocks.join("\n\n") }],
          },
        ],
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

