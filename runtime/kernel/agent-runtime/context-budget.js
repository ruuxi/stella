const providerBudgets = new Map();
const forcedCompactions = new Map();

const MIN_HEADROOM_TOKENS = 32_768;
const MAX_INPUT_FRACTION = 0.82;
const ESTIMATED_BYTES_PER_TOKEN = 3;
const ESTIMATED_IMAGE_TOKENS = 2_000;

export const setProviderContextWindow = (threadKey, contextWindow) => {
  const parsed = Number(contextWindow);
  if (!threadKey || !Number.isFinite(parsed) || parsed <= 0) {
    providerBudgets.delete(threadKey);
    return;
  }
  providerBudgets.set(threadKey, Math.floor(parsed));
};

export const clearProviderContextWindow = (threadKey) => {
  providerBudgets.delete(threadKey);
};

const estimatePayloadTokens = (payload) => {
  let imageTokens = 0;
  const json = JSON.stringify(payload, function (key, value) {
    if (typeof value !== "string") return value;
    const lowerKey = key.toLowerCase();
    if (
      value.startsWith("data:image/") ||
      lowerKey.includes("image_url") ||
      (lowerKey === "url" && /^https?:\/\//i.test(value))
    ) {
      imageTokens += ESTIMATED_IMAGE_TOKENS;
      return "[model-visible image]";
    }
    return value;
  });
  const bytes = new TextEncoder().encode(json ?? "").byteLength;
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN) + imageTokens;
};

export const preflightProviderPayload = (threadKey, payload, model) => {
  const contextWindow = providerBudgets.get(threadKey);
  if (!contextWindow) return;

  const inputBudget = Math.max(
    8_000,
    Math.min(
      Math.floor(contextWindow * MAX_INPUT_FRACTION),
      contextWindow - MIN_HEADROOM_TOKENS,
    ),
  );
  const estimatedTokens = estimatePayloadTokens(payload);
  if (estimatedTokens < inputBudget) return;

  throw new Error(
    `Context preflight context_length_exceeded before provider dispatch: ` +
      `estimated ${estimatedTokens} model-visible tokens against a ${contextWindow}-token ` +
      `window (${inputBudget}-token safe input budget) for ${model?.provider ?? "provider"}/${model?.id ?? "model"}.`,
  );
};

export const withForcedThreadCompaction = async (threadKey, run) => {
  forcedCompactions.set(threadKey, (forcedCompactions.get(threadKey) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const remaining = (forcedCompactions.get(threadKey) ?? 1) - 1;
    if (remaining > 0) forcedCompactions.set(threadKey, remaining);
    else forcedCompactions.delete(threadKey);
  }
};

export const isThreadCompactionForced = (threadKey) =>
  (forcedCompactions.get(threadKey) ?? 0) > 0;
