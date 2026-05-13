/**
 * Background home-suggestions refresh.
 *
 * Fires after a successful General-agent finalize once the per-conversation
 * counter (`runtime_home_suggestions_state.finalizes_since_refresh`) has
 * crossed `HOME_SUGGESTIONS_REFRESH_THRESHOLD`. The pass is a fire-and-
 * forget cheap-LLM call that:
 *
 *   1. Reads the current persisted home_suggestions for the conversation.
 *   2. Reads the most recent N thread_summaries (rollout summaries from
 *      every General-agent run, regardless of Dream-processed state).
 *   3. Asks the model to keep, replace, or extend the suggestion list.
 *   4. If the model returns a new list, appends a fresh `home_suggestions`
 *      event so the next time the Ideas surface mounts it picks it up.
 *
 * Errors are swallowed - the home Ideas surface continues to read the
 * previous suggestion event (or the bundled defaults) until next refresh.
 */

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type { Context, Message } from "../../ai/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";
import type { LocalContextEvent } from "../local-history.js";
import type { ThreadSummaryRow } from "../memory/thread-summaries-store.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";

const logger = createRuntimeLogger("agent-runtime.home-suggestions-refresh");

/**
 * Fire the cheap-LLM refresh after this many successful General-agent
 * finalizes have happened in the same conversation since the last refresh.
 * Tuned for a "few completed tasks ⇒ revisit suggestions" cadence; raise
 * if the LLM call cost becomes a concern.
 */
export const HOME_SUGGESTIONS_REFRESH_THRESHOLD = 20;

const MAX_THREAD_SUMMARIES = 20;
const MAX_THREAD_SUMMARY_CHARS = 2_000;
const MAX_SUGGESTIONS = 16;

const VALID_CATEGORIES = new Set(["stella", "task", "skill", "schedule"]);

type HomeSuggestion = {
  category: "stella" | "task" | "skill" | "schedule";
  label: string;
  prompt: string;
};

type RefreshDecision =
  | { kind: "no_change" }
  | { kind: "replace"; suggestions: HomeSuggestion[] };

const SYSTEM_PROMPT = [
  "You maintain a personalized list of home-screen idea suggestions for Stella, an AI desktop assistant.",
  "",
  "You receive (a) the user's CURRENT suggestions and (b) brief summaries of what the user has actually been working on with Stella recently.",
  "",
  "Decide whether to keep the suggestions exactly as-is, or to replace the list with an updated one that better reflects what the user actually does.",
  "",
  "Rules:",
  '  1. If nothing meaningful has changed about the user, respond with `{"decision":"no_change"}` and stop.',
  '  2. Otherwise respond with `{"decision":"replace","suggestions":[...]}` containing the new list.',
  "  3. The new list must contain between 4 and 16 suggestions, distributed across the four categories: stella, task, skill, schedule.",
  '  4. Each suggestion is `{"category":"stella"|"task"|"skill"|"schedule","label":"<3-8 word action label>","prompt":"<full instruction the user would send to Stella>"}`.',
  "  5. Keep suggestions the user already has if they still look relevant. Replace stale ones with new ones grounded in the recent activity. Add new suggestions that fit themes you observe.",
  "  6. Do not invent specifics that aren't supported by the activity summaries; prefer slightly generic phrasing over hallucinated detail.",
  "  7. The skill category is only for reusable patterns Stella can save under state/skills/<name>/SKILL.md, not one-off research or web lookup.",
  "  8. Skill suggestions should ask Stella to create or update a named skill from repeated workflows, tool usage patterns, repo conventions, or recurring user preferences found in the summaries.",
  '  9. Always keep one stella suggestion that says "Add a music player to home" with prompt "Add the music player to my home page. The component already exists at src/app/home/MusicPlayer.tsx — integrate it into the home page layout, don\'t rebuild it.".',
  "",
  "Output ONLY a single JSON object. No markdown fences, no commentary.",
].join("\n");

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;

const buildUserPrompt = (args: {
  currentSuggestions: HomeSuggestion[];
  recentSummaries: ThreadSummaryRow[];
}): string => {
  const lines: string[] = [];
  lines.push("Current home suggestions (JSON):");
  lines.push(
    JSON.stringify(args.currentSuggestions, null, 2),
  );
  lines.push("");
  lines.push(
    `Recent General-agent run summaries (newest first, up to ${MAX_THREAD_SUMMARIES}):`,
  );
  if (args.recentSummaries.length === 0) {
    lines.push("(none)");
  } else {
    for (const row of args.recentSummaries) {
      const summary = truncate(
        row.rolloutSummary.trim(),
        MAX_THREAD_SUMMARY_CHARS,
      );
      lines.push(
        `- [${new Date(row.sourceUpdatedAt).toISOString()}] ${summary}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Decide whether to update the suggestion list, then respond with the JSON object specified in the system prompt.",
  );
  return lines.join("\n");
};

const stripFences = (text: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text.trim());
  return fenced ? fenced[1]!.trim() : text.trim();
};

const sliceFirstJsonObject = (text: string): string | null => {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
};

const normalizeSuggestion = (value: unknown): HomeSuggestion | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const category = typeof o.category === "string"
    ? o.category.toLowerCase().trim()
    : "";
  if (!VALID_CATEGORIES.has(category)) return null;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!label || !prompt) return null;
  return {
    category: category as HomeSuggestion["category"],
    label,
    prompt,
  };
};

const parseDecision = (text: string): RefreshDecision | null => {
  const candidates = [stripFences(text), text.trim()];
  for (const candidate of candidates) {
    const slice = sliceFirstJsonObject(candidate) ?? candidate;
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const o = parsed as Record<string, unknown>;
    const decisionRaw = typeof o.decision === "string"
      ? o.decision.toLowerCase().trim()
      : "";
    if (decisionRaw === "no_change") {
      return { kind: "no_change" };
    }
    if (decisionRaw === "replace" && Array.isArray(o.suggestions)) {
      const suggestions = o.suggestions
        .map(normalizeSuggestion)
        .filter((entry): entry is HomeSuggestion => entry != null)
        .slice(0, MAX_SUGGESTIONS);
      if (suggestions.length >= 4) {
        return { kind: "replace", suggestions };
      }
    }
  }
  return null;
};

const readCurrentSuggestions = (events: LocalContextEvent[]): HomeSuggestion[] => {
  const last = [...events]
    .reverse()
    .find((event) => event.type === "home_suggestions");
  if (!last || typeof last.payload !== "object" || last.payload == null) {
    return [];
  }
  const payload = last.payload as { suggestions?: unknown };
  if (!Array.isArray(payload.suggestions)) return [];
  return payload.suggestions
    .map(normalizeSuggestion)
    .filter((entry): entry is HomeSuggestion => entry != null);
};

type RefreshDeps = {
  conversationId: string;
  stellaRoot: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  appendLocalChatEvent: (args: LocalChatAppendEventArgs) => void;
  listLocalChatEvents: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
};

const runRefresh = async (deps: RefreshDeps): Promise<void> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: deps.stellaRoot,
    modelId: deps.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : (await deps.resolvedLlm.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    logger.debug("home-suggestions-refresh.skipped.no-api-key");
    return;
  }

  const events = deps.listLocalChatEvents(deps.conversationId, 200);
  const currentSuggestions = readCurrentSuggestions(events);
  const recentSummaries = deps.store.threadSummariesStore.listRecent({
    limit: MAX_THREAD_SUMMARIES,
  });
  if (recentSummaries.length === 0) {
    logger.debug("home-suggestions-refresh.skipped.no-summaries");
    return;
  }

  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildUserPrompt({ currentSuggestions, recentSummaries }),
        },
      ],
      timestamp: Date.now(),
    },
  ];

  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages,
  };

  let responseText: string;
  try {
    if (useClaudeCode) {
      responseText = await runClaudeCodeAgentTextCompletion({
        stellaRoot: deps.stellaRoot,
        agentType: AGENT_IDS.HOME_SUGGESTIONS,
        context,
      });
    } else {
      const response = await completeSimple(deps.resolvedLlm.model, context, {
        apiKey,
      });
      responseText = readAssistantText(response);
    }
  } catch (error) {
    logger.debug("home-suggestions-refresh.completeSimple.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const decision = parseDecision(responseText);
  if (!decision) {
    logger.debug("home-suggestions-refresh.unparseable", {
      preview: responseText.slice(0, 200),
    });
    return;
  }
  if (decision.kind === "no_change") {
    logger.debug("home-suggestions-refresh.no-change");
    return;
  }

  deps.appendLocalChatEvent({
    conversationId: deps.conversationId,
    type: "home_suggestions",
    payload: { suggestions: decision.suggestions },
  });
  logger.debug("home-suggestions-refresh.replaced", {
    count: decision.suggestions.length,
  });
};

/**
 * Fire-and-forget background home-suggestions refresh. Never throws and
 * never blocks the caller. Resets the per-conversation counter immediately
 * so a quick follow-up finalize does not double-trigger.
 */
export const spawnHomeSuggestionsRefresh = (deps: RefreshDeps): void => {
  try {
    deps.store.resetGeneralFinalizesSinceHomeSuggestionsRefresh(
      deps.conversationId,
    );
  } catch {
    // counter reset is best-effort
  }
  void runRefresh(deps).catch((error) => {
    logger.debug("home-suggestions-refresh.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
