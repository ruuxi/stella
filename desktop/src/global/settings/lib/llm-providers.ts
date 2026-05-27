/**
 * Catalog of providers users can authenticate against locally (BYOK / OAuth).
 *
 * Anything in this list shows up in the model picker's left rail — even if
 * it currently has no models in the runtime catalog — so users can sign in
 * before picking a model. Catalog-only providers (those with models but no
 * BYOK story) still show up via the merged catalog groups.
 */
export type LlmProviderEntry = {
  key: string;
  label: string;
  /** Hint text shown inside the API key input when adding a new key. */
  placeholder: string;
};

/** Provider keys always listed in the Agents model rail (even with no catalog models). */
export const CURSOR_PROVIDER_KEY = "cursor";

/** Model override prefix for the Cursor SDK general-agent runtime. */
export const CURSOR_MODEL_PREFIX = "cursor/";

const PROVIDER_RAIL_PRIORITY: readonly string[] = [
  "stella",
  "openrouter",
  "anthropic",
  "openai",
  "openai-codex",
  CURSOR_PROVIDER_KEY,
  "xai",
  "local",
];

export const compareProviderRailOrder = (
  aKey: string,
  bKey: string,
  aLabel: string,
  bLabel: string,
): number => {
  const aIndex = PROVIDER_RAIL_PRIORITY.indexOf(aKey);
  const bIndex = PROVIDER_RAIL_PRIORITY.indexOf(bKey);
  const aRank = aIndex >= 0 ? aIndex : PROVIDER_RAIL_PRIORITY.length;
  const bRank = bIndex >= 0 ? bIndex : PROVIDER_RAIL_PRIORITY.length;
  if (aRank !== bRank) return aRank - bRank;
  return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
};

export const LLM_PROVIDERS: readonly LlmProviderEntry[] = [
  { key: "local", label: "Local", placeholder: "No API key needed" },
  {
    key: CURSOR_PROVIDER_KEY,
    label: "Cursor",
    placeholder: "Cursor API key",
  },
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { key: "openai", label: "OpenAI", placeholder: "sk-..." },
  { key: "openai-codex", label: "OpenAI Codex", placeholder: "eyJ..." },
  { key: "google", label: "Google", placeholder: "AIza..." },
  { key: "kimi-coding", label: "Kimi (Moonshot AI)", placeholder: "sk-..." },
  { key: "zai", label: "Z.AI", placeholder: "..." },
  { key: "xai", label: "xAI", placeholder: "xai-..." },
  { key: "groq", label: "Groq", placeholder: "gsk_..." },
  { key: "mistral", label: "Mistral", placeholder: "..." },
  { key: "cerebras", label: "Cerebras", placeholder: "..." },
  { key: "openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
  { key: "fal", label: "fal", placeholder: "fal-..." },
  { key: "vercel-ai-gateway", label: "Vercel AI Gateway", placeholder: "..." },
  { key: "opencode", label: "OpenCode Zen", placeholder: "..." },
  { key: "github-copilot", label: "GitHub Copilot", placeholder: "OAuth only" },
  { key: "google-gemini-cli", label: "Gemini CLI", placeholder: "OAuth only" },
  {
    key: "google-antigravity",
    label: "Google Antigravity",
    placeholder: "OAuth only",
  },
];

export const LOCAL_MODEL_PROVIDER_KEYS = new Set(
  LLM_PROVIDERS.map((entry) => entry.key),
);

const byKey = new Map(LLM_PROVIDERS.map((entry) => [entry.key, entry]));

export const getLlmProviderEntry = (
  key: string,
): LlmProviderEntry | undefined => byKey.get(key);

export const isApiKeyOnlyPlaceholder = (placeholder: string) =>
  placeholder.trim().toLowerCase() === "oauth only";
