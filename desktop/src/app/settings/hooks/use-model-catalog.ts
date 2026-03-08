import { useState, useEffect, useMemo } from "react";
import { extractProvider as localExtractProvider } from "@/app/settings/lib/model-providers";

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
};

type ProviderGroup = {
  provider: string;
  models: CatalogModel[];
};

type CatalogApiModel = {
  id: string;
  name?: string;
  type?: string;
};

type CatalogApiResponse = {
  data?: CatalogApiModel[];
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

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";

let inFlightCatalogRequest: Promise<CatalogModel[] | null> | null = null;
let cachedCatalog: { models: CatalogModel[]; expiresAt: number } | null = null;

function extractProvider(id: string): string {
  return localExtractProvider(id) ?? "unknown";
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

async function fetchCatalogModels(): Promise<CatalogModel[] | null> {
  if (
    ENABLE_CATALOG_CACHE &&
    cachedCatalog &&
    cachedCatalog.expiresAt > Date.now()
  ) {
    return cachedCatalog.models;
  }

  if (!inFlightCatalogRequest) {
    inFlightCatalogRequest = (async () => {
      try {
        const res = await fetch(CATALOG_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CatalogApiResponse;
        const list: CatalogModel[] = (data?.data ?? [])
          .filter((m) => !m.type || m.type === "language")
          .map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            provider: extractProvider(m.id),
          }));

        if (list.length === 0) {
          return null;
        }

        if (ENABLE_CATALOG_CACHE) {
          cachedCatalog = {
            models: list,
            expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
          };
        }

        return list;
      } catch {
        return null;
      } finally {
        inFlightCatalogRequest = null;
      }
    })();
  }

  return inFlightCatalogRequest;
}

export function useModelCatalog() {
  const [models, setModels] = useState<CatalogModel[]>(FALLBACK_MODELS);
  const [loading, setLoading] = useState(true);
  const groups = useMemo(() => groupByProvider(models), [models]);

  useEffect(() => {
    let canceled = false;

    async function fetchCatalog() {
      const list = await fetchCatalogModels();
      if (!canceled && list) {
        setModels(list);
      }
      if (!canceled) setLoading(false);
    }

    fetchCatalog();
    return () => { canceled = true; };
  }, []);

  return { models, groups, loading };
}
