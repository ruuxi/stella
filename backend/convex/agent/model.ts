/**
 * Centralized model configuration for all AI requests.
 * Update this file to switch models or providers per agent type.
 */

type ModelConfig = {
  model: string;
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
  model: "zai/glm-4.7",
  temperature: 1.0,
  maxOutputTokens: 4096,
  providerOptions: {
    gateway: {
      order: ["cerebras"],
    },
  },
};

const AGENT_MODELS: Record<string, ModelConfig> = {
  orchestrator: {
    model: "anthropic/claude-opus-4.6",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  general: {
    model: "anthropic/claude-opus-4.6",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  explore: {
    model: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  browser: {
    model: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["fireworks"],
      },
    },
  },

  self_mod: {
    model: "anthropic/claude-opus-4.6",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  memory_ops: {
    model: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 8096,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  embedding: {
    model: "alibaba/qwen3-embedding-8b",
    providerOptions: {
      deepinfra: {
        dimensions: 1536,
      },
    },
  },

  synthesis: {
    model: "openai/gpt-5.2-codex",
    temperature: 1.0,
    maxOutputTokens: 2500,
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
    model: "openai/gpt-4o-mini",
    temperature: 0.3,
    maxOutputTokens: 300,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  welcome: {
    model: "anthropic/claude-opus-4.6",
    temperature: 1.0,
    maxOutputTokens: 1000,
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
