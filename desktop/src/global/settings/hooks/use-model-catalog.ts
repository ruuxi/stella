import { useState, useEffect, useMemo } from "react";
import { createServiceRequest } from "@/infra/http/service-request";
import { extractProvider as localExtractProvider } from "@/global/settings/lib/model-providers";
import { STELLA_MODELS_PATH } from "../../../../electron/core/runtime/stella-provider.js";

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  upstreamModel?: string;
};

type ProviderGroup = {
  provider: string;
  models: CatalogModel[];
};

type CatalogApiModel = {
  id: string;
  name?: string;
  provider?: string;
  type?: string;
  upstreamModel?: string;
};

type CatalogApiResponse = {
  data?: CatalogApiModel[];
};

const FALLBACK_STELLA_MODELS: CatalogModel[] = [
  { id: "stella/default", name: "Stella Recommended", provider: "stella" },
  { id: "stella/anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "stella", upstreamModel: "anthropic/claude-opus-4.5" },
  { id: "stella/anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", provider: "stella", upstreamModel: "anthropic/claude-sonnet-4.6" },
  { id: "stella/google/gemini-3-flash", name: "Gemini 3 Flash", provider: "stella", upstreamModel: "google/gemini-3-flash" },
  { id: "stella/inception/mercury-2", name: "Mercury 2", provider: "stella", upstreamModel: "inception/mercury-2" },
  { id: "stella/moonshotai/kimi-k2.5", name: "Kimi K2.5", provider: "stella", upstreamModel: "moonshotai/kimi-k2.5" },
  { id: "stella/openai/gpt-5.4", name: "GPT-5.4", provider: "stella", upstreamModel: "openai/gpt-5.4" },
  { id: "stella/zai/glm-4.7", name: "GLM 4.7", provider: "stella", upstreamModel: "zai/glm-4.7" },
];

const FALLBACK_DIRECT_MODELS: CatalogModel[] = [
  { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "openai" },
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

function mergeCatalogModels(...lists: Array<CatalogModel[] | null | undefined>): CatalogModel[] {
  const merged = new Map<string, CatalogModel>();
  for (const list of lists) {
    for (const model of list ?? []) {
      if (!merged.has(model.id)) {
        merged.set(model.id, model);
      }
    }
  }
  return Array.from(merged.values());
}

async function fetchStellaCatalogModels(): Promise<CatalogModel[] | null> {
  try {
    const request = await createServiceRequest(STELLA_MODELS_PATH);
    const res = await fetch(request.endpoint, { headers: request.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CatalogApiResponse;
    const list: CatalogModel[] = (data?.data ?? [])
      .filter((model) => !model.type || model.type === "language")
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        provider: model.provider ?? "stella",
        upstreamModel: model.upstreamModel,
      }));
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

async function fetchDirectCatalogModels(): Promise<CatalogModel[] | null> {
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CatalogApiResponse;
    const list: CatalogModel[] = (data?.data ?? [])
      .filter((model) => !model.type || model.type === "language")
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        provider: extractProvider(model.id),
      }));
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
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
        const [stellaModels, directModels] = await Promise.all([
          fetchStellaCatalogModels(),
          fetchDirectCatalogModels(),
        ]);
        const list = mergeCatalogModels(
          stellaModels ?? FALLBACK_STELLA_MODELS,
          directModels ?? FALLBACK_DIRECT_MODELS,
        );

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
  const [models, setModels] = useState<CatalogModel[]>(
    mergeCatalogModels(FALLBACK_STELLA_MODELS, FALLBACK_DIRECT_MODELS),
  );
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

