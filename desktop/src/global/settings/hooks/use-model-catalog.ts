import { useState, useEffect, useMemo } from "react";
import { createServiceRequest } from "@/infra/http/service-request";
import { STELLA_MODELS_PATH } from "@/shared/stella-api";

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

type CatalogFetchResult = {
  models: CatalogModel[];
  error: string | null;
};

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";

let inFlightCatalogRequest: Promise<CatalogFetchResult> | null = null;
let cachedCatalog: { models: CatalogModel[]; expiresAt: number } | null = null;

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
  return Array.from(map.entries()).map(([provider, models]) => ({ provider, models }));
}

async function fetchStellaCatalogModels(): Promise<CatalogModel[]> {
  const request = await createServiceRequest(STELLA_MODELS_PATH);
  const res = await fetch(request.endpoint, { headers: request.headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as CatalogApiResponse;
  return (data?.data ?? [])
    .filter((model) => !model.type || model.type === "language")
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      provider: model.provider ?? "stella",
      upstreamModel: model.upstreamModel,
    }));
}

async function fetchCatalogModels(): Promise<CatalogFetchResult> {
  if (
    ENABLE_CATALOG_CACHE &&
    cachedCatalog &&
    cachedCatalog.expiresAt > Date.now()
  ) {
    return { models: cachedCatalog.models, error: null };
  }

  if (!inFlightCatalogRequest) {
    inFlightCatalogRequest = (async () => {
      try {
        const list = await fetchStellaCatalogModels();

        if (ENABLE_CATALOG_CACHE && list.length > 0) {
          cachedCatalog = {
            models: list,
            expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
          };
        }

        return { models: list, error: null };
      } catch (error) {
        return { models: [], error: toErrorMessage(error) };
      } finally {
        inFlightCatalogRequest = null;
      }
    })();
  }

  return inFlightCatalogRequest;
}

export function useModelCatalog() {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupByProvider(models), [models]);

  useEffect(() => {
    let canceled = false;

    async function fetchCatalog() {
      const result = await fetchCatalogModels();
      if (!canceled) {
        setModels(result.models);
        setError(result.error);
      }
      if (!canceled) setLoading(false);
    }

    fetchCatalog();
    return () => { canceled = true; };
  }, []);

  return { models, groups, loading, error };
}
