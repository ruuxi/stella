export const ORCHESTRATOR_HISTORY_MAX_TOKENS = 24_000;
export const SUBAGENT_THREAD_HISTORY_MAX_TOKENS = 24_000;
export const TASK_DELIVERY_HISTORY_MAX_TOKENS = 10_000;
export const AUTOMATION_HISTORY_MAX_TOKENS = 18_000;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : fallback;
};

const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = parsePositiveInt(
  process.env.TC_DEFAULT_CTX_WINDOW_TOKENS,
  128_000,
);

export const THREAD_COMPACTION_RESERVE_TOKENS = parsePositiveInt(
  process.env.TC_RESERVE_TOKENS,
  16_384,
);

export const THREAD_COMPACTION_KEEP_RECENT_TOKENS = parsePositiveInt(
  process.env.TC_KEEP_RECENT_TOKENS,
  20_000,
);

const MODEL_CONTEXT_WINDOW_HINTS: Record<string, number> = {
  "anthropic/claude-opus-4.6": 200_000,
  "anthropic/claude-sonnet-4": 200_000,
  "openai/gpt-5.2-codex": 272_000,
  "zai/glm-4.7": 128_000,
  "moonshotai/kimi-k2.5": 128_000,
};

export const resolveContextWindowTokens = (model: unknown): number => {
  if (typeof model !== "string" || model.trim().length === 0) {
    return DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  }
  return MODEL_CONTEXT_WINDOW_HINTS[model] ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
};

export const computeCompactionTriggerTokens = (model: unknown): number =>
  Math.max(8_000, resolveContextWindowTokens(model) - THREAD_COMPACTION_RESERVE_TOKENS);
