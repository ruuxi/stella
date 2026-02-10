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

// ============================================================================
// DEFAULT - Fallback for unknown agent types
// ============================================================================
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

// ============================================================================
// PER-AGENT MODEL CONFIGURATION
// ============================================================================
const AGENT_MODELS: Record<string, ModelConfig> = {
  // Orchestrator (top-level responder)
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

  // Main general-purpose agent
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

  // Codebase exploration and research
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

  // Browser automation via Playwright
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

  // Self-modification agent
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

  // Cheap model for memory recall filter, save dedup, extraction, decay summarization
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

  // Core memory synthesis (first-launch discovery)
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

  // Welcome message generation (personalized greeting)
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

/**
 * Export individual configs for direct access if needed.
 */
export { DEFAULT_MODEL, AGENT_MODELS };
