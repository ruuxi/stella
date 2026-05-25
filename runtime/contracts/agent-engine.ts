export type AgentRuntimeEngine =
  | "default"
  | "claude_code_local"
  | "cursor_sdk"
  | "codex_cli";

export const DEFAULT_AGENT_RUNTIME_ENGINE: AgentRuntimeEngine = "default";

export const AGENT_RUNTIME_ENGINES: readonly AgentRuntimeEngine[] = [
  "default",
  "claude_code_local",
  "cursor_sdk",
  "codex_cli",
];

const AGENT_RUNTIME_ENGINE_LABELS: Record<AgentRuntimeEngine, string> = {
  default: "Stella",
  claude_code_local: "Claude Code",
  cursor_sdk: "Cursor",
  codex_cli: "Codex",
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
