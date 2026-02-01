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
// DISCOVERY - Context discovery agents
// ============================================================================
const DISCOVERY_MODEL: ModelConfig = {
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
    model: "anthropic/claude-opus-4.5",
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
    model: "anthropic/claude-opus-4.5",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  // Memory retrieval agent
  memory: {
    model: "zai/glm-4.7",
    temperature: 1.0,
    maxOutputTokens: 4096,
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

  // Self-modification agent (if re-enabled)
  self_mod: {
    model: "anthropic/claude-opus-4.5",
    temperature: 1.0,
    maxOutputTokens: 8192,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  // Context discovery agents (lightweight, read-only)
  discovery_browser: DISCOVERY_MODEL,
  discovery_dev: DISCOVERY_MODEL,
  discovery_comms: DISCOVERY_MODEL,
  discovery_apps: DISCOVERY_MODEL,

  // Core memory synthesis (distills discovery outputs)
  discovery_synthesis: {
    model: "google/gemini-3-flash",
    temperature: 1.0,
    maxOutputTokens: 12096,
    providerOptions: {
      gateway: {
        order: ["cerebras"],
      },
    },
  },

  // Embedding model for episodic memory
  embedding: {
    model: "alibaba/qwen3-embedding-8b",
    providerOptions: {
      deepinfra: {
        dimensions: 1536, // Match schema vector index dimensions
      },
    },
  },

  // Cheap model for memory extraction, dedup, decay summarization
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
export { DEFAULT_MODEL, DISCOVERY_MODEL, AGENT_MODELS };
