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

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";

let inFlightCatalogRequest: Promise<CatalogModel[] | null> | null = null;
let cachedCatalog: { models: CatalogModel[]; expiresAt: number } | null = null;

function groupByProvider(models: CatalogModel[]): ProviderGroup[] {
  const map = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model);
    map.set(model.provider, list);
  }
  return Array.from(map.entries()).map(([provider, models]) => ({ provider, models }));
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
        const list = await fetchStellaCatalogModels();
        if (!list || list.length === 0) {
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
  const [models, setModels] = useState<CatalogModel[]>([]);
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
