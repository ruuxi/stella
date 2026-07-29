export type AgentRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

export const DEFAULT_AGENT_RUNTIME_ENGINE: AgentRuntimeEngine = "default";
/** Saved Codex/ChatGPT model preference. Kept even when not in the live catalog. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/** Reasoning levels accepted by spawn_agent's optional model suffix. */
export type SpawnReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Effective reasoning setting captured from a running agent turn. */
export type AgentModelReasoningEffort =
  | "none"
  | "minimal"
  | SpawnReasoningEffort;

/**
 * Serializable snapshot of the effective model configuration for a turn.
 * Manager threads persist this so every resume uses the spawning
 * Orchestrator's engine/model instead of resolving an independent Manager
 * default.
 */
export type AgentModelConfigSnapshot = {
  engine: AgentRuntimeEngine;
  /** Exact in-process route used for model metadata and native execution. */
  routeModel: string;
  /** Exact engine-native model when an external engine owns execution. */
  engineModel?: string;
  reasoningEffort?: AgentModelReasoningEffort;
};

export const AGENT_RUNTIME_ENGINES: readonly AgentRuntimeEngine[] = [
  "default",
  "claude_code_local",
  "codex_cli",
];

const AGENT_RUNTIME_ENGINE_LABELS: Record<AgentRuntimeEngine, string> = {
  default: "Stella",
  claude_code_local: "Claude Code",
  codex_cli: "Codex",
};

/**
 * Per-spawn engine selection carried by spawn_agent's optional `model`
 * parameter. `stella` and plain model references explicitly select `default`
 * (the in-process Stella runtime); `codex[/<model>]` and
 * `claude-code[/<model>]` select an external engine. Scoped to a single
 * spawned agent run — never persisted to preferences.
 */
export type SpawnEngineSelection =
  | { engine: "default"; model?: never }
  | {
      engine: Exclude<AgentRuntimeEngine, "default">;
      /** Engine-native model id pinned for this run (e.g. `gpt-5.4-codex`, `opus`). */
      model?: string;
    };

export const isAgentRuntimeEngine = (
  value: unknown,
): value is AgentRuntimeEngine =>
  typeof value === "string" &&
  (AGENT_RUNTIME_ENGINES as readonly string[]).includes(value);

export const coerceAgentRuntimeEngine = (value: unknown): AgentRuntimeEngine =>
  isAgentRuntimeEngine(value) ? value : DEFAULT_AGENT_RUNTIME_ENGINE;

export const getAgentRuntimeEngineLabel = (
  engine: AgentRuntimeEngine,
): string => AGENT_RUNTIME_ENGINE_LABELS[engine];
