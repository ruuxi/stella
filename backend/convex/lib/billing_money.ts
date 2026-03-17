const MICRO_CENTS_PER_CENT = 1_000_000;
const CENTS_PER_DOLLAR = 100;

export type TokenPriceConfig = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
};

type ServicePriceCatalog = {
  defaultUsd: number;
  services: Record<string, number>;
};

const DEFAULT_TOKEN_PRICE: TokenPriceConfig = {
  // Reference baseline from OpenCode Go docs/token table.
  inputPerMillionUsd: 0.6,
  outputPerMillionUsd: 3.0,
};

type TokenPriceCatalog = {
  default: TokenPriceConfig;
  models: Record<string, TokenPriceConfig>;
};

const parsePositiveNumber = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
};

const normalizePriceConfig = (
  value: unknown,
  fallback: TokenPriceConfig,
): TokenPriceConfig => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  return {
    inputPerMillionUsd: parsePositiveNumber(record.inputPerMillionUsd, fallback.inputPerMillionUsd),
    outputPerMillionUsd: parsePositiveNumber(record.outputPerMillionUsd, fallback.outputPerMillionUsd),
    cacheReadPerMillionUsd: parsePositiveNumber(record.cacheReadPerMillionUsd, fallback.cacheReadPerMillionUsd ?? 0),
    cacheWritePerMillionUsd: parsePositiveNumber(record.cacheWritePerMillionUsd, fallback.cacheWritePerMillionUsd ?? 0),
    reasoningPerMillionUsd: parsePositiveNumber(record.reasoningPerMillionUsd, fallback.reasoningPerMillionUsd ?? fallback.outputPerMillionUsd),
  };
};

const loadTokenPriceCatalog = (): TokenPriceCatalog => {
  const raw = process.env.STELLA_TOKEN_PRICE_CATALOG_JSON?.trim();
  if (!raw) {
    return {
      default: DEFAULT_TOKEN_PRICE,
      models: {},
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const defaults = normalizePriceConfig(parsed.default, DEFAULT_TOKEN_PRICE);
    const modelEntries =
      parsed.models && typeof parsed.models === "object"
        ? parsed.models as Record<string, unknown>
        : {};

    const models: Record<string, TokenPriceConfig> = {};
    for (const [model, config] of Object.entries(modelEntries)) {
      const normalizedModel = model.trim();
      if (!normalizedModel) {
        continue;
      }
      models[normalizedModel] = normalizePriceConfig(config, defaults);
    }

    return {
      default: defaults,
      models,
    };
  } catch (error) {
    console.warn("[billing] Invalid STELLA_TOKEN_PRICE_CATALOG_JSON. Falling back to defaults.", error);
    return {
      default: DEFAULT_TOKEN_PRICE,
      models: {},
    };
  }
};

const TOKEN_PRICE_CATALOG = loadTokenPriceCatalog();

const normalizeServiceKey = (value: string): string =>
  value.trim().toLowerCase();

const loadServicePriceCatalog = (): ServicePriceCatalog => {
  const raw = process.env.STELLA_SERVICE_PRICE_CATALOG_JSON?.trim();
  if (!raw) {
    return {
      defaultUsd: 0,
      services: {},
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const serviceEntries =
      parsed.services && typeof parsed.services === "object"
        ? parsed.services as Record<string, unknown>
        : {};

    const services: Record<string, number> = {};
    for (const [serviceKey, value] of Object.entries(serviceEntries)) {
      const normalizedKey = normalizeServiceKey(serviceKey);
      if (!normalizedKey) {
        continue;
      }
      services[normalizedKey] = parsePositiveNumber(value, 0);
    }

    return {
      defaultUsd: parsePositiveNumber(parsed.defaultUsd, 0),
      services,
    };
  } catch (error) {
    console.warn("[billing] Invalid STELLA_SERVICE_PRICE_CATALOG_JSON. Falling back to defaults.", error);
    return {
      defaultUsd: 0,
      services: {},
    };
  }
};

const SERVICE_PRICE_CATALOG = loadServicePriceCatalog();

export const centsToMicroCents = (cents: number) => Math.round(cents * MICRO_CENTS_PER_CENT);

export const dollarsToMicroCents = (dollars: number) => centsToMicroCents(dollars * CENTS_PER_DOLLAR);

export const microCentsToDollars = (microCents: number) =>
  microCents / (MICRO_CENTS_PER_CENT * CENTS_PER_DOLLAR);

export const computeUsageCostMicroCents = (args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  price?: TokenPriceConfig;
}) => {
  const price = args.price ?? TOKEN_PRICE_CATALOG.models[args.model] ?? TOKEN_PRICE_CATALOG.default;
  const cachedInputTokens = Math.max(0, args.cachedInputTokens ?? 0);
  const cacheWriteInputTokens = Math.max(0, args.cacheWriteInputTokens ?? 0);
  const billableInputTokens = Math.max(
    0,
    args.inputTokens - cachedInputTokens - cacheWriteInputTokens,
  );
  const reasoningTokens = Math.max(0, args.reasoningTokens ?? 0);
  const textOutputTokens = Math.max(0, args.outputTokens - reasoningTokens);

  const inputUsd = (billableInputTokens / 1_000_000) * price.inputPerMillionUsd;
  const cachedInputUsd = (cachedInputTokens / 1_000_000) * (price.cacheReadPerMillionUsd ?? 0);
  const cacheWriteUsd = (cacheWriteInputTokens / 1_000_000) * (price.cacheWritePerMillionUsd ?? 0);
  const outputUsd = (textOutputTokens / 1_000_000) * price.outputPerMillionUsd;
  const reasoningUsd = (reasoningTokens / 1_000_000) * (price.reasoningPerMillionUsd ?? price.outputPerMillionUsd);

  return dollarsToMicroCents(inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd + reasoningUsd);
};

export const resolveServicePriceUsd = (serviceKey: string): number => {
  let currentKey = normalizeServiceKey(serviceKey);
  while (currentKey) {
    const configured = SERVICE_PRICE_CATALOG.services[currentKey];
    if (typeof configured === "number") {
      return configured;
    }

    const separatorIndex = currentKey.lastIndexOf(":");
    if (separatorIndex < 0) {
      break;
    }
    currentKey = currentKey.slice(0, separatorIndex);
  }

  return SERVICE_PRICE_CATALOG.defaultUsd;
};

export const computeServiceCostMicroCents = (serviceKey: string): number =>
  dollarsToMicroCents(resolveServicePriceUsd(serviceKey));
