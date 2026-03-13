const MICRO_CENTS_PER_CENT = 1_000_000;
const CENTS_PER_DOLLAR = 100;

export type TokenPriceConfig = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
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

export const centsToMicroCents = (cents: number) => Math.round(cents * MICRO_CENTS_PER_CENT);

export const dollarsToMicroCents = (dollars: number) => centsToMicroCents(dollars * CENTS_PER_DOLLAR);

export const microCentsToDollars = (microCents: number) =>
  microCents / (MICRO_CENTS_PER_CENT * CENTS_PER_DOLLAR);

export const computeUsageCostMicroCents = (args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}) => {
  const price = TOKEN_PRICE_CATALOG.models[args.model] ?? TOKEN_PRICE_CATALOG.default;
  const inputUsd = (Math.max(0, args.inputTokens) / 1_000_000) * price.inputPerMillionUsd;
  const outputUsd = (Math.max(0, args.outputTokens) / 1_000_000) * price.outputPerMillionUsd;

  return dollarsToMicroCents(inputUsd + outputUsd);
};
