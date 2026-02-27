/**
 * Centralized model configuration for all AI requests.
 * Update this file to switch models or providers per agent type.
 */

export type ModelConfig = {
  model: string;
  fallback?: string; // fallback model if primary fails
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: {
    gateway?: {
      only?: string[];
      order?: string[];
    };
    deepinfra?: {
      dimensions?: number;
      [key: string]: any;
    };
    [key: string]: any;
  };
};

const DEFAULT_MODEL: ModelConfig = {
  model: "anthropic/claude-opus-4.6",
  fallback: "moonshotai/kimi-k2.5",
  temperature: 1.0,
  maxOutputTokens: 16096,
  providerOptions: {
    gateway: {
      order: ["cerebras"],
    },
  },
};

const AGENT_MODELS: Record<string, ModelConfig> = {
  orchestrator: {
    model: "anthropic/claude-opus-4.6",
    fallback: "anthropic/claude-opus-4.5",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  general: {
    model: "anthropic/claude-opus-4.6",
    fallback: "anthropic/claude-opus-4.5",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  explore: {
    model: "zai/glm-4.7",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  browser: {
    model: "moonshotai/kimi-k2.5",
    fallback: "anthropic/claude-sonnet-4-5",
    temperature: 1.0,
    maxOutputTokens: 16192,
    providerOptions: {
      gateway: {
        order: ["fireworks"],
      },
    },
  },

  memory_discovery_fact_extraction: {
    model: "zai/glm-4.7",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 12096,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  memory_recall_rerank: {
    model: "zai/glm-4.7",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 4096,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  session_compaction_summary: {
    model: "zai/glm-4.7",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 12096,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  thread_compaction_summary: {
    model: "zai/glm-4.7",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 12096,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  ai_proxy_embedding: {
    model: "alibaba/qwen3-embedding-8b",
    providerOptions: {
      deepinfra: {
        dimensions: 1536,
      },
    },
  },

  synthesis: {
    model: "openai/gpt-5.3-codex",
    fallback: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 9500,
    providerOptions: {
      gateway: {
        order: ["cerebras", "groq"],
      },
      openai: {
        reasoningEffort: "low",
      },
    },
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

  welcome: {
    model: "anthropic/claude-opus-4.6",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 10000,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
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
};

/**
 * Get the model config for a specific agent type.
 * Falls back to DEFAULT_MODEL if agent type is not configured.
 */
export function getModelConfig(agentType: string): ModelConfig {
  return AGENT_MODELS[agentType] ?? DEFAULT_MODEL;
}

export { DEFAULT_MODEL, AGENT_MODELS };
