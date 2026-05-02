import { useState, useEffect, useMemo } from "react";
import { createServiceRequest } from "@/infra/http/service-request";
import { STELLA_MODELS_PATH } from "@/shared/stella-api";

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  upstreamModel?: string;
};

export type CatalogDefaultModel = {
  agentType: string;
  model: string;
  resolvedModel: string;
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
  defaults?: CatalogDefaultModel[];
};

type CatalogFetchResult = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
  error: string | null;
};

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";

let inFlightCatalogRequest: Promise<CatalogFetchResult> | null = null;
let cachedCatalog: {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
  expiresAt: number;
} | null = null;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "Unable to load model catalog.";

function groupByProvider(models: CatalogModel[]): ProviderGroup[] {
  const map = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model);
    map.set(model.provider, list);
  }
  return Array.from(map.entries()).map(([provider, models]) => ({
    provider,
    models,
  }));
}

async function fetchStellaCatalogModels(): Promise<{
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
}> {
  const request = await createServiceRequest(STELLA_MODELS_PATH);
  const res = await fetch(request.endpoint, { headers: request.headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as CatalogApiResponse;
  const models = (data?.data ?? [])
    .filter((model) => !model.type || model.type === "language")
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      provider: model.provider ?? "stella",
      upstreamModel: model.upstreamModel,
    }));
  return {
    models,
    defaults: data.defaults ?? [],
  };
}

async function fetchCatalogModels(): Promise<CatalogFetchResult> {
  if (
    ENABLE_CATALOG_CACHE &&
    cachedCatalog &&
    cachedCatalog.expiresAt > Date.now()
  ) {
    return {
      models: cachedCatalog.models,
      defaults: cachedCatalog.defaults,
      error: null,
    };
  }

  if (!inFlightCatalogRequest) {
    inFlightCatalogRequest = (async () => {
      try {
        const result = await fetchStellaCatalogModels();

        if (ENABLE_CATALOG_CACHE && result.models.length > 0) {
          cachedCatalog = {
            models: result.models,
            defaults: result.defaults,
            expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
          };
        }

        return {
          models: result.models,
          defaults: result.defaults,
          error: null,
        };
      } catch (error) {
        return { models: [], defaults: [], error: toErrorMessage(error) };
      } finally {
        inFlightCatalogRequest = null;
      }
    })();
  }

  return inFlightCatalogRequest;
}

export function useModelCatalog() {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [defaults, setDefaults] = useState<CatalogDefaultModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupByProvider(models), [models]);

  useEffect(() => {
    let canceled = false;

    async function fetchCatalog() {
      const result = await fetchCatalogModels();
      if (!canceled) {
        setModels(result.models);
        setDefaults(result.defaults);
        setError(result.error);
      }
      if (!canceled) setLoading(false);
    }

    fetchCatalog();
    return () => {
      canceled = true;
    };
  }, []);

  return { models, defaults, groups, loading, error };
}
