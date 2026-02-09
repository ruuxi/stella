import { useState, useEffect } from "react";

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
};

type ProviderGroup = {
  provider: string;
  models: CatalogModel[];
};

const FALLBACK_MODELS: CatalogModel[] = [
  { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "openai/gpt-5.2", name: "GPT-5.2", provider: "openai" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
  { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", provider: "moonshotai" },
  { id: "zai/glm-4.7", name: "GLM 4.7", provider: "zai" },
];

function extractProvider(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "unknown";
}

function groupByProvider(models: CatalogModel[]): ProviderGroup[] {
  const map = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model);
    map.set(model.provider, list);
  }
  return Array.from(map.entries()).map(([provider, models]) => ({ provider, models }));
}

export function useModelCatalog() {
  const [models, setModels] = useState<CatalogModel[]>(FALLBACK_MODELS);
  const [groups, setGroups] = useState<ProviderGroup[]>(() => groupByProvider(FALLBACK_MODELS));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;

    async function fetchCatalog() {
      try {
        const res = await fetch("https://ai-gateway.vercel.sh/v1/models");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list: CatalogModel[] = (data?.data ?? [])
          .filter((m: { type?: string }) => !m.type || m.type === "language")
          .map((m: { id: string; name?: string }) => ({
            id: m.id,
            name: m.name ?? m.id,
            provider: extractProvider(m.id),
          }));

        if (!canceled && list.length > 0) {
          setModels(list);
          setGroups(groupByProvider(list));
        }
      } catch {
        // Keep fallback models
      } finally {
        if (!canceled) setLoading(false);
      }
    }

    fetchCatalog();
    return () => { canceled = true; };
  }, []);

  return { models, groups, loading };
}
