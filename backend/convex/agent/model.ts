/**
 * Centralized model configuration for all AI requests.
 *
 * ALL model selections and the managed gateway config live here.
 * Update this file to switch models, providers, or the gateway URL.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import { AGENT_IDS } from "../lib/agent_constants";

// ─── Managed Gateway ────────────────────────────────────────────────────────

/**
 * Managed AI gateway configuration.
 * Change `baseURL` and `apiKeyEnvVar` to point to any OpenAI-compatible gateway.
 */
export const MANAGED_GATEWAY = {
  baseURL: "https://ai-gateway.vercel.sh/v1",
  apiKeyEnvVar: "AI_GATEWAY_API_KEY",
} as const;

/**
 * Create an AI SDK LanguageModel routed through the managed gateway.
 * Used by backend HTTP routes that call the AI SDK directly.
 */
export function createManagedModel(modelId: string): LanguageModel {
  const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar]?.trim() ?? "";
  const provider = createOpenAI({ apiKey, baseURL: MANAGED_GATEWAY.baseURL });
  return provider(modelId);
}

// ─── Model Config ───────────────────────────────────────────────────────────

export type ModelConfig = {
  model: string;
  fallback?: string; // fallback model if primary fails
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
};

const DEFAULT_MODEL: ModelConfig = {
  model: "moonshotai/kimi-k2.5",
  fallback: "anthropic/claude-opus-4.5",
  temperature: 1.0,
  maxOutputTokens: 16192,
  providerOptions: {
    openai: {
      reasoningEffort: "low",
    },
    gateway: {
      order: ["baseten", "fireworks", "amazon-bedrock"],
    },
  },
};

const COMPACTION_MODEL: ModelConfig = {
  model: "zai/glm-4.7",
  fallback: "moonshotai/kimi-k2.5",
  temperature: 1.0,
  maxOutputTokens: 12096,
  providerOptions: {
    gateway: {
      order: ["cerebras"],
    },
  },
};

const AGENT_MODELS: Record<string, ModelConfig> = {
  [AGENT_IDS.OFFLINE_RESPONDER]: DEFAULT_MODEL,

  [AGENT_IDS.ORCHESTRATOR]: {
    model: "moonshotai/kimi-k2.5",
    fallback: "openai/gpt-5.4",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "baseten", "amazon-bedrock"],
      },
    },
  },

  [AGENT_IDS.GENERAL]: {
    model: "moonshotai/kimi-k2.5",
    fallback: "openai/gpt-5.4",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "baseten", "amazon-bedrock"],
      },
    },
  },

  [AGENT_IDS.SELF_MOD]: {
    model: "moonshotai/kimi-k2.5",
    fallback: "openai/gpt-5.4",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "baseten", "amazon-bedrock"],
      },
    },
  },

  [AGENT_IDS.EXPLORE]: {
    model: "zai/glm-4.7",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      gateway: {
        order: ["cerebras", "baseten", "fireworks", "amazon-bedrock"],
      },
    },
  },

  [AGENT_IDS.BROWSER]: {
    model: "openai/gpt-5.4",
    fallback: "anthropic/claude-sonnet-4.6",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      gateway: {
        order: ["amazon-bedrock", "fireworks"],
      },
    },
  },

  // "app" is the frontend agent type name for browser/app automation
  [AGENT_IDS.APP]: {
    model: "openai/gpt-5.4",
    fallback: "anthropic/claude-sonnet-4.6",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      gateway: {
        order: ["amazon-bedrock", "fireworks"],
      },
    },
  },

  [AGENT_IDS.AUTO]: {
    model: "moonshotai/kimi-k2.5",
    fallback: "openai/gpt-5.4",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "baseten", "amazon-bedrock"],
      },
    },
  },

  "panel-generate": {
    model: "inception/mercury-2",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["fireworks", "cerebras"],
      },
      openai: {
        reasoningEffort: "high",
        forceReasoning: true,
      },
    },
  },

  synthesis: {
    model: "inception/mercury-2",
    fallback: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 9500,
    providerOptions: {
      gateway: {
        order: ["fireworks", "cerebras"],
      },
      openai: {
        reasoningEffort: "high",
        forceReasoning: true,
      },
    },
  },

  session_compaction_summary: COMPACTION_MODEL,

  thread_compaction_summary: COMPACTION_MODEL,

  welcome: {
    model: "anthropic/claude-sonnet-4.6",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 2400,
    providerOptions: {
      gateway: {
        order: ["fireworks", "cerebras"],
      },
    },
  },

  mercury: {
    model: "inception/mercury-2",
    fallback: "moonshotai/kimi-k2.5",
  },

  suggestions: {
    model: "moonshotai/kimi-k2.5",
    fallback: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 10000,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },


  llm_best: {
    model: "moonshotai/kimi-k2.5",
    fallback: "openai/gpt-5.4",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "baseten", "amazon-bedrock"],
      },
    },
  },

  llm_fast: {
    model: "google/gemini-3-flash",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 0.8,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras", "fireworks", "amazon-bedrock"],
      },
    },
  },

  media_llm: {
    model: "google/gemini-3-flash",
    fallback: "openai/gpt-5.4",
    temperature: 0.7,
    maxOutputTokens: 8192,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "amazon-bedrock", "cerebras"],
      },
    },
  },
  music_prompt: {
    model: "google/gemini-3-flash",
    fallback: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  // --- Backend tasks (previously hardcoded in HTTP routes / tools) ---

  skill_metadata: {
    model: "inception/mercury-2",
    temperature: 1.0,
    maxOutputTokens: 2000,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        forceReasoning: true,
      },
    },
  },

  skill_selection: {
    model: "inception/mercury-2",
    temperature: 1.0,
    maxOutputTokens: 3000,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        forceReasoning: true,
      },
    },
  },

  search_html: {
    model: "inception/mercury-2",
    temperature: 1.0,
    maxOutputTokens: 16096,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        forceReasoning: true,
      },
    },
  },

  store_security_review: {
    model: "openai/gpt-5.4",
    fallback: "anthropic/claude-sonnet-4.6",
    temperature: 1.0,
    maxOutputTokens: 2500,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      gateway: {
        order: ["amazon-bedrock", "fireworks"],
      },
    },
  },

  store_image_safety_review: {
    model: "google/gemini-3-flash",
    fallback: "openai/gpt-5.4",
    temperature: 1.0,
    maxOutputTokens: 8000,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
      gateway: {
        order: ["fireworks", "amazon-bedrock"],
      },
    },
  },
};

/**
 * Get the model config for a specific agent type.
 */
export function getModelConfig(agentType: string): ModelConfig {
  const config = AGENT_MODELS[agentType];
  if (!config) throw new Error(`No model config for agent type: ${agentType}`);
  return config;
}

export function hasModelConfig(agentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_MODELS, agentType);
}

export { DEFAULT_MODEL, AGENT_MODELS };



