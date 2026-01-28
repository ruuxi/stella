/**
 * Centralized model configuration for all AI requests.
 * Update this file to switch models or providers per agent type.
 */

type ModelConfig = {
  model: string;
  providerOptions?: {
    gateway?: {
      only?: string[];
      order?: string[];
    };
  };
};

// ============================================================================
// DEFAULT - Fallback for unknown agent types
// ============================================================================
const DEFAULT_MODEL: ModelConfig = {
  model: "zai/glm-4.7",
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
  // Main general-purpose agent
  general: {
    model: "anthropic/claude-opus-4.5",
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  // Codebase exploration and research
  explore: {
    model: "zai/glm-4.7",
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  // Browser automation via Playwright
  browser: {
    model: "moonshotai/kimi-k2.5",
    providerOptions: {
      gateway: {
        order: ["fireworks"],
      },
    },
  },

  // Self-modification agent (if re-enabled)
  self_mod: {
    model: "anthropic/claude-opus-4.5",
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
