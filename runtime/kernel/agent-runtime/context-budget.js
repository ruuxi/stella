const providerBudgets = new Map();
const forcedCompactions = new Map();

const MAX_INPUT_FRACTION = 0.7;
const ESTIMATED_BYTES_PER_TOKEN = 3;
const ESTIMATED_IMAGE_TOKENS = 2_000;
const EXACT_INSPECTION_FRACTION = 0.75;
const JSON_ESCAPE_RE = /["\\\u0000-\u001f\ud800-\udfff]/;

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

const isImageValue = (key, value) =>
  value.startsWith("data:image/") ||
  key.toLowerCase().includes("image_url") ||
  (key.toLowerCase() === "url" && /^https?:\/\//i.test(value));

const addQuickString = (value, state) => {
  const bytes = Buffer.byteLength(value, "utf8") + 2;
  state.maxBytes += bytes + (JSON_ESCAPE_RE.test(value) ? value.length * 5 : 0);
};

const measureQuick = (value, key, state) => {
  if (typeof value === "string") {
    if (isImageValue(key, value)) {
      state.imageTokens += ESTIMATED_IMAGE_TOKENS;
      addQuickString("[model-visible image]", state);
    } else {
      addQuickString(value, state);
    }
    return;
  }
  if (value === null || typeof value === "undefined") {
    state.maxBytes += 4;
    return;
  }
  if (typeof value === "number") {
    const bytes = Number.isFinite(value) ? String(value).length : 4;
    state.maxBytes += bytes;
    return;
  }
  if (typeof value === "boolean") {
    const bytes = value ? 4 : 5;
    state.maxBytes += bytes;
    return;
  }
  if (Array.isArray(value)) {
    state.maxBytes += 2 + Math.max(0, value.length - 1);
    for (const item of value) measureQuick(item, "", state);
    return;
  }
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") {
      state.maxBytes = Number.POSITIVE_INFINITY;
      return;
    }
    state.maxBytes += 2;
    let fields = 0;
    for (const field in value) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      const item = value[field];
      if (
        typeof item === "undefined" ||
        typeof item === "function" ||
        typeof item === "symbol"
      ) {
        continue;
      }
      if (fields > 0) {
        state.maxBytes += 1;
      }
      fields += 1;
      addQuickString(field, state);
      state.maxBytes += 1;
      measureQuick(item, field, state);
    }
  }
};

const estimatePayloadTokens = (payload, inputBudget) => {
  const quick = { maxBytes: 0, imageTokens: 0 };
  measureQuick(payload, "", quick);
  const maxTokens =
    Math.ceil(quick.maxBytes / ESTIMATED_BYTES_PER_TOKEN) + quick.imageTokens;
  if (maxTokens < inputBudget * EXACT_INSPECTION_FRACTION) {
    return maxTokens;
  }

  let imageTokens = 0;
  const json = JSON.stringify(payload, function (key, value) {
    if (typeof value === "string" && isImageValue(key, value)) {
      imageTokens += ESTIMATED_IMAGE_TOKENS;
      return "[model-visible image]";
    }
    return value;
  });
  const bytes = Buffer.byteLength(json ?? "", "utf8");
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN) + imageTokens;
};

export const preflightProviderPayload = (threadKey, payload, model) => {
  const liveContextWindow = Number(model?.contextWindow);
  const contextWindow =
    Number.isFinite(liveContextWindow) && liveContextWindow > 0
      ? Math.floor(liveContextWindow)
      : providerBudgets.get(threadKey);
  if (!contextWindow) return;

  const inputBudget = Math.max(
    8_000,
    Math.floor(contextWindow * MAX_INPUT_FRACTION),
  );
  const estimatedTokens = estimatePayloadTokens(payload, inputBudget);
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
