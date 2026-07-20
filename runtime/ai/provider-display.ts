/**
 * Single source of truth for human-readable LLM provider names.
 *
 * Browser-safe (no Node imports) so both the runtime route resolver
 * (runtime/kernel/model-routing.ts) and the desktop model picker / catalog
 * (desktop/src/global/settings/lib/model-catalog.ts) consume the SAME labels —
 * otherwise an error toast and the picker could call the same provider two
 * different things.
 *
 * NOTE: the BYOK "add a key" rail (desktop llm-providers.ts) intentionally uses
 * longer vendor-qualified labels + input placeholders for that signup surface;
 * that table is a separate concern and not merged here.
 */

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure OpenAI",
  cerebras: "Cerebras",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-vertex": "Google Vertex",
  groq: "Groq",
  huggingface: "Hugging Face",
  local: "Local",
  "kimi-coding": "Kimi",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax China",
  mistral: "Mistral",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  // Distinct from plain "OpenAI": this is the ChatGPT-subscription (Codex
  // OAuth) route, and both providers can appear in the same grouped list
  // now that OpenAI API models are cataloged too.
  "openai-codex": "ChatGPT",
  openrouter: "OpenRouter",
  stella: "Stella",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  zai: "Z.AI",
};

export function getProviderDisplayName(provider: string): string {
  const normalized = provider.trim();
  const mapped = PROVIDER_DISPLAY_NAMES[normalized];
  if (mapped) return mapped;
  return normalized
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
