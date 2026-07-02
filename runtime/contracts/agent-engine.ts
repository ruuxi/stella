export type AgentRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

export const DEFAULT_AGENT_RUNTIME_ENGINE: AgentRuntimeEngine = "default";

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
 * parameter (`codex`, `codex/<model>`, `claude-code`, `claude-code/<model>`).
 * Scoped to a single spawned agent run — never persisted to preferences.
 */
export type SpawnEngineSelection = {
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
