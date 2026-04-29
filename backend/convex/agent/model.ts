/**
 * Centralized model configuration for all AI requests.
 *
 * Model selection is split into:
 * - modes: reusable full model configs (model, fallback, routing, tokens, etc.)
 * - task mappings: each agent/task chooses a single mode
 * - audience overrides: sparse per-plan patches applied to modes
 */
import { AGENT_IDS } from "../lib/agent_constants";
import {
  getManagedGatewayConfig,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
export { getManagedGatewayConfig } from "../lib/managed_gateway";
export type { ManagedGatewayProvider } from "../lib/managed_gateway";

// Legacy default for older call sites that still assume one gateway.
export const MANAGED_GATEWAY = getManagedGatewayConfig("openrouter");

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type ModelConfig = {
  model: string;
  fallback?: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  fallbackManagedGatewayProvider?: ManagedGatewayProvider;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  fallbackProviderOptions?: Record<string, Record<string, JSONValue>>;
};

export const MANAGED_MODEL_AUDIENCES = [
  "anonymous",
  "free",
  "go",
  "pro",
  "plus",
  "ultra",
  "go_fallback",
  "pro_fallback",
  "plus_fallback",
  "ultra_fallback",
] as const;

export type ManagedModelAudience = (typeof MANAGED_MODEL_AUDIENCES)[number];

export const MODEL_MODES = [
  "standard",
  "free",
  "compact",
  "fast",
  "social_moderation",
  "smart",
  "best",
  "sota",
  "fashion",
  "reasoning",
  "synthesis",
  "media",
] as const;

export type ModelMode = (typeof MODEL_MODES)[number];

type ModeConfig = Omit<ModelConfig, "fallback" | "fallbackManagedGatewayProvider" | "fallbackProviderOptions"> & {
  fallbackMode?: ModelMode;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const clone = <T>(value: T): T => structuredClone(value);

const deepMerge = <T>(base: T, patch?: Partial<T>): T => {
  if (!patch) return clone(base);

  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return clone((patch as T | undefined) ?? base);
  }

  const output = clone(base) as Record<string, unknown>;
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;

    const baseValue = output[key];
    output[key] = isPlainObject(baseValue) && isPlainObject(patchValue)
      ? deepMerge(baseValue, patchValue)
      : clone(patchValue);
  }

  return output as T;
};

const gatewayOptions = (
  provider: ManagedGatewayProvider,
): Record<string, Record<string, JSONValue>> => ({
  gateway: {
    order: [provider],
  },
});

const BASE_MODE_CONFIGS: Record<ModelMode, ModeConfig> = {
  standard: {
    model: "accounts/fireworks/models/kimi-k2p6",
    fallbackMode: "fast",
    managedGatewayProvider: "fireworks",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  free: {
    model: "minimax/minimax-m2.7",
    fallbackMode: "standard",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 4096,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("openrouter"),
    },
  },

  compact: {
    model: "accounts/fireworks/routers/kimi-k2p5-turbo",
    fallbackMode: "fast",
    managedGatewayProvider: "fireworks",
    temperature: 1.0,
    maxOutputTokens: 12096,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  fast: {
    model: "inception/mercury-2",
    fallbackMode: "standard",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("openrouter"),
    },
  },

  social_moderation: {
    model: "deepseek/deepseek-v4-flash",
    fallbackMode: "fast",
    managedGatewayProvider: "openrouter",
    temperature: 0.7,
    maxOutputTokens: 512,
    providerOptions: {
      ...gatewayOptions("openrouter"),
    },
  },

  smart: {
    model: "accounts/fireworks/models/kimi-k2p6",
    fallbackMode: "fast",
    managedGatewayProvider: "fireworks",
    temperature: 1.0,
    maxOutputTokens: 12096,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  best: {
    model: "anthropic/claude-opus-4.6",
    fallbackMode: "smart",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("openrouter"),
    },
  },

  sota: {
    model: "openai/gpt-5.5",
    fallbackMode: "best",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 32768,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  fashion: {
    model: "openai/gpt-5.5",
    fallbackMode: "best",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 32768,
    providerOptions: {
      ...gatewayOptions("openrouter"),
    },
  },

  reasoning: {
    model: "openai/gpt-5.4-mini",
    fallbackMode: "smart",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 16096,
    providerOptions: {
      ...gatewayOptions("openrouter"),
      openai: {
        reasoningEffort: "medium",
      },
    },
  },

  synthesis: {
    model: "openai/gpt-5.4-mini",
    fallbackMode: "standard",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 30000,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      ...gatewayOptions("openrouter"),
    },
  },

  media: {
    model: "anthropic/claude-opus-4.6",
    fallbackMode: "smart",
    managedGatewayProvider: "openrouter",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      ...gatewayOptions("openrouter"),
    },
  },
};

const AUDIENCE_MODE_OVERRIDES: Record<ManagedModelAudience, Partial<Record<ModelMode, Partial<ModeConfig>>>> = {
  anonymous: {},
  free: {},
  go: {},
  pro: {},
  plus: {},
  ultra: {},
  go_fallback: {},
  pro_fallback: {},
  plus_fallback: {},
  ultra_fallback: {},
};

export const TASK_MODEL_MODES: Record<string, ModelMode> = {
  [AGENT_IDS.OFFLINE_RESPONDER]: "standard",
  [AGENT_IDS.ORCHESTRATOR]: "sota",
  [AGENT_IDS.GENERAL]: "sota",
  [AGENT_IDS.FASHION]: "fashion",

  schedule: "standard",
  synthesis: "synthesis",
  session_compaction_summary: "compact",
  thread_compaction_summary: "compact",
  welcome: "fashion",
  mercury: "fast",
  music_prompt: "media",
  search_html: "fast",
  store_thread: "sota",
  store_security_review: "sota",
  store_image_safety_review: "media",

  // Memory pipeline (mirrors split: cheap extract / strong consolidate).
  // Stage 1 thread "extraction" is implicit today (General's final response is
  // the rollout summary). Stage 2 = Dream consolidation, run on the strongest
  // tier so it can faithfully merge weeks of context. Chronicle's recursive
  // summarizer ticks every minute, so it must stay cheap.
  dream: "sota",
  chronicle: "synthesis",
};

const buildResolvedModeConfig = (
  mode: ModelMode,
  rawModeCatalog: Record<ModelMode, ModeConfig>,
): ModelConfig => {
  const config = rawModeCatalog[mode];
  const fallbackConfig = config.fallbackMode ? rawModeCatalog[config.fallbackMode] : undefined;

  return {
    model: config.model,
    fallback: fallbackConfig?.model,
    managedGatewayProvider: config.managedGatewayProvider,
    fallbackManagedGatewayProvider: fallbackConfig?.managedGatewayProvider,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    providerOptions: config.providerOptions ? clone(config.providerOptions) : undefined,
    fallbackProviderOptions: fallbackConfig?.providerOptions
      ? clone(fallbackConfig.providerOptions)
      : undefined,
  };
};

const buildAudienceModeCatalog = (
  audience: ManagedModelAudience,
): Record<ModelMode, ModelConfig> => {
  const rawModeCatalog = {} as Record<ModelMode, ModeConfig>;

  for (const mode of MODEL_MODES) {
    rawModeCatalog[mode] = deepMerge(
      BASE_MODE_CONFIGS[mode],
      AUDIENCE_MODE_OVERRIDES[audience][mode],
    );
  }

  const resolvedModeCatalog = {} as Record<ModelMode, ModelConfig>;
  for (const mode of MODEL_MODES) {
    resolvedModeCatalog[mode] = buildResolvedModeConfig(mode, rawModeCatalog);
  }

  return resolvedModeCatalog;
};

const buildAudienceAgentCatalog = (
  audience: ManagedModelAudience,
  modeCatalog: Record<ModelMode, ModelConfig>,
): Record<string, ModelConfig> => {
  const taskCatalog: Record<string, ModelConfig> = {};

  for (const [agentType, mode] of Object.entries(TASK_MODEL_MODES)) {
    taskCatalog[agentType] = clone(modeCatalog[mode]);
  }

  return taskCatalog;
};

const AUDIENCE_MODE_CONFIGS: Record<ManagedModelAudience, Record<ModelMode, ModelConfig>> = {
  anonymous: buildAudienceModeCatalog("anonymous"),
  free: buildAudienceModeCatalog("free"),
  go: buildAudienceModeCatalog("go"),
  pro: buildAudienceModeCatalog("pro"),
  plus: buildAudienceModeCatalog("plus"),
  ultra: buildAudienceModeCatalog("ultra"),
  go_fallback: buildAudienceModeCatalog("go_fallback"),
  pro_fallback: buildAudienceModeCatalog("pro_fallback"),
  plus_fallback: buildAudienceModeCatalog("plus_fallback"),
  ultra_fallback: buildAudienceModeCatalog("ultra_fallback"),
};

export const AUDIENCE_AGENT_MODELS: Record<ManagedModelAudience, Record<string, ModelConfig>> = {
  anonymous: buildAudienceAgentCatalog("anonymous", AUDIENCE_MODE_CONFIGS.anonymous),
  free: buildAudienceAgentCatalog("free", AUDIENCE_MODE_CONFIGS.free),
  go: buildAudienceAgentCatalog("go", AUDIENCE_MODE_CONFIGS.go),
  pro: buildAudienceAgentCatalog("pro", AUDIENCE_MODE_CONFIGS.pro),
  plus: buildAudienceAgentCatalog("plus", AUDIENCE_MODE_CONFIGS.plus),
  ultra: buildAudienceAgentCatalog("ultra", AUDIENCE_MODE_CONFIGS.ultra),
  go_fallback: buildAudienceAgentCatalog("go_fallback", AUDIENCE_MODE_CONFIGS.go_fallback),
  pro_fallback: buildAudienceAgentCatalog("pro_fallback", AUDIENCE_MODE_CONFIGS.pro_fallback),
  plus_fallback: buildAudienceAgentCatalog("plus_fallback", AUDIENCE_MODE_CONFIGS.plus_fallback),
  ultra_fallback: buildAudienceAgentCatalog("ultra_fallback", AUDIENCE_MODE_CONFIGS.ultra_fallback),
};

export const AGENT_MODELS = AUDIENCE_AGENT_MODELS.free;
export const DEFAULT_MODEL = AGENT_MODELS[AGENT_IDS.OFFLINE_RESPONDER];

export const resolveManagedModelAudience = (args: {
  plan: "free" | "go" | "pro" | "plus" | "ultra";
  isAnonymous?: boolean;
  downgraded?: boolean;
}): ManagedModelAudience => {
  if (args.isAnonymous) {
    return "anonymous";
  }
  if (args.plan === "free") {
    return "free";
  }
  if (args.downgraded) {
    return `${args.plan}_fallback` as ManagedModelAudience;
  }
  return args.plan;
};

export function getModeConfig(
  mode: ModelMode,
  audience: ManagedModelAudience = "free",
): ModelConfig {
  const config = AUDIENCE_MODE_CONFIGS[audience]?.[mode];
  if (!config) throw new Error(`No model mode config for mode: ${mode}`);
  return config;
}

export function getModelConfig(
  agentType: string,
  audience: ManagedModelAudience = "free",
): ModelConfig {
  const config = AUDIENCE_AGENT_MODELS[audience]?.[agentType] ?? AGENT_MODELS[agentType];
  if (!config) throw new Error(`No model config for agent type: ${agentType}`);
  return config;
}

export function hasModelConfig(agentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_MODELS, agentType);
}

export function isModelMode(value: string): value is ModelMode {
  return Object.prototype.hasOwnProperty.call(BASE_MODE_CONFIGS, value);
}

export function listManagedModelIds(): string[] {
  const modelIds = new Set<string>();

  const append = (value?: string) => {
    const trimmed = value?.trim();
    if (trimmed) {
      modelIds.add(trimmed);
    }
  };

  append(DEFAULT_MODEL.model);
  append(DEFAULT_MODEL.fallback);

  for (const modeCatalog of Object.values(AUDIENCE_MODE_CONFIGS)) {
    for (const config of Object.values(modeCatalog)) {
      append(config.model);
      append(config.fallback);
    }
  }

  for (const configMap of Object.values(AUDIENCE_AGENT_MODELS)) {
    for (const config of Object.values(configMap)) {
      append(config.model);
      append(config.fallback);
    }
  }

  return Array.from(modelIds).sort();
}
