/**
 * Per-task progress micro-summaries.
 *
 * The renderer streams a small chunk of the General agent's most recent
 * reasoning (or fallback assistant/tool text) into this action while a
 * task is in flight. We summarize that chunk into a 3-6 word
 * normie-friendly phrase ("Reading inbox", "Drafting reply", …) which
 * the home overview renders as a sub-list under each active task.
 *
 * Scope is intentionally tiny: a single short LLM completion on a cheap
 * model. Rate-limited per user; not persisted on the backend (the
 * renderer keeps the rolling list in memory alongside its task state).
 */
import { v } from "convex/values";
import { action } from "../_generated/server";
import { requireUserId } from "../auth";
import { enforceActionRateLimit, RATE_EXPENSIVE } from "../lib/rate_limits";
import { resolveModelConfig } from "./model_resolver";
import { assistantText, completeManagedChat, usageSummaryFromAssistant } from "../runtime_ai/managed";
import {
  assertManagedUsageAllowed,
  scheduleManagedUsage,
} from "../lib/managed_billing";

const MAX_INPUT_CHARS = 3_000;
const MAX_SUMMARY_CHARS = 80;

const SYSTEM_PROMPT = `You watch what an AI assistant is currently working on and describe it in 3-6 plain English words a non-technical person would understand.

Rules:
- Output ONLY the phrase. No quotes, no period, no preamble.
- 3 to 6 words, present continuous when natural ("Reading the inbox", "Drafting a reply").
- Describe the current focus, not past steps. Avoid jargon (no tool names, file paths, IDs, code).
- If the input is empty or unclear, output "Working on it".`;

const cleanSummary = (raw: string): string => {
  // Trim, strip surrounding quotes/punctuation that small models love to add,
  // collapse whitespace, and clamp length.
  let value = raw.trim();
  if (!value) return "";
  // Common opening filler from chat-tuned models.
  value = value.replace(/^(?:sure[,!.]?\s*|here(?:'s| is)\s*[:\-]?\s*)/i, "");
  value = value.replace(/^["'`*_\s]+|["'`*_\s.!?]+$/g, "");
  value = value.replace(/\s+/g, " ");
  if (value.length > MAX_SUMMARY_CHARS) {
    value = value.slice(0, MAX_SUMMARY_CHARS).trimEnd();
  }
  // Reject obvious refusals so the UI can fall back silently.
  if (/^(i\s+(can(?:'t|not)|am unable))/i.test(value)) return "";
  return value;
};

export const summarize = action({
  args: {
    text: v.string(),
  },
  returns: v.object({
    summary: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<{ summary: string | null }> => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "task_summary.summarize",
      ownerId,
      RATE_EXPENSIVE,
    );

    const trimmed = args.text.trim();
    if (!trimmed) {
      return { summary: null };
    }
    // Tail bias: the most recent activity is what we want to describe.
    const sliced = trimmed.length > MAX_INPUT_CHARS
      ? trimmed.slice(-MAX_INPUT_CHARS)
      : trimmed;

    const access = await assertManagedUsageAllowed(ctx, ownerId);
    const config = await resolveModelConfig(ctx, "task_summary", ownerId, { access });

    const startedAt = Date.now();
    let message;
    try {
      message = await completeManagedChat({
        config,
        context: {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [{ type: "text", text: sliced }],
            timestamp: Date.now(),
          }],
        },
      });
    } catch {
      // Cheap, ephemeral signal — never let a single failure surface to
      // the user; the overview just won't grow a new line this tick.
      return { summary: null };
    }

    await scheduleManagedUsage(ctx, {
      ownerId,
      agentType: "task_summary",
      model: config.model,
      durationMs: Date.now() - startedAt,
      success: true,
      usage: usageSummaryFromAssistant(message),
    });

    const summary = cleanSummary(assistantText(message));
    return { summary: summary.length > 0 ? summary : null };
  },
});
