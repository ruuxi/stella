import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import { useModelCatalogUpdatedAt } from "@/global/settings/hooks/model-catalog-updated-at";
import { createServiceRequest } from "@/infra/http/service-request";
import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeDirectProviderCatalogModels,
  normalizeManagedGatewayCatalogModels,
  normalizeStellaCatalogModels,
  searchCatalogModels,
  type CatalogApiResponse,
  type CatalogDefaultModel,
  type CatalogModel,
  type ModelsDevApi,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import { STELLA_MODELS_PATH } from "@/shared/stella-api";
import {
  resolveBillingAudience,
  type ManagedModelAudience,
} from "@/shared/billing/audience";

type CatalogFetchResult = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
  error: string | null;
  stale: boolean;
};

type AuthSessionData =
  | {
      user?: {
        id?: string | null;
        email?: string | null;
        isAnonymous?: boolean | null;
      } | null;
      session?: {
        id?: string | null;
      } | null;
    }
  | null
  | undefined;

type BillingStatus = {
  plan: "free" | "go" | "pro" | "plus" | "ultra";
  usage: {
    rollingUsedUsd: number;
    rollingLimitUsd: number;
    weeklyUsedUsd: number;
    weeklyLimitUsd: number;
    monthlyUsedUsd: number;
    monthlyLimitUsd: number;
  };
};

type CatalogCacheEntry = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
  fetchedAt: number;
};

const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";
const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const inFlightCatalogRequests = new Map<string, Promise<CatalogFetchResult>>();
const catalogCache = new Map<string, CatalogCacheEntry>();
const MODELS_DEV_API_URL = "https://models.dev/api.json";
let managedGatewayCatalogCache: {
  directModels: CatalogModel[];
  stellaModels: CatalogModel[];
  fetchedAt: number;
} | null = null;
let inFlightManagedGatewayCatalogRequest: Promise<{
  directModels: CatalogModel[];
  stellaModels: CatalogModel[];
}> | null = null;
/**
 * Last-known catalog payload, used to seed `useState` synchronously so the
 * picker re-opens without flashing a loading state. The keyed
 * `catalogCache` above is the authoritative per-audience store; this
 * just lets the hook avoid a render where every list is empty while the
 * async cache hit lands.
 */
let lastSeenCatalog: {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
} | null = null;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "Unable to load model catalog.";

function getCatalogRequestCacheKey(
  request: Awaited<ReturnType<typeof createServiceRequest>>,
  authAudienceKey: string,
  modelCatalogUpdatedAt: number | null,
): string {
  return [
    request.endpoint,
    authAudienceKey,
    `modelCatalogUpdatedAt:${modelCatalogUpdatedAt ?? "none"}`,
    request.headers["X-Device-ID"] ?? "device:none",
  ].join("|");
}

function isCatalogCacheFresh(entry: Pick<CatalogCacheEntry, "fetchedAt">) {
  return Date.now() - entry.fetchedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS;
}

function getBillingAudienceKey(
  billingStatus: BillingStatus | undefined,
): string | null {
  if (!billingStatus) {
    return null;
  }
  const { plan, usage } = billingStatus;
  if (plan === "free") {
    return "free";
  }
  const isDowngraded =
    usage.rollingUsedUsd >= usage.rollingLimitUsd ||
    usage.weeklyUsedUsd >= usage.weeklyLimitUsd ||
    usage.monthlyUsedUsd >= usage.monthlyLimitUsd;
  return isDowngraded ? `${plan}_fallback` : plan;
}

function getSessionCacheKey(sessionData: AuthSessionData): string {
  if (!sessionData) {
    return "signed-out";
  }
  const user = sessionData.user;
  const identity =
    user?.id ?? user?.email ?? sessionData.session?.id ?? "unknown";
  const sessionId = sessionData.session?.id ?? "no-session";
  const kind = user?.isAnonymous === true ? "anonymous" : "account";
  return `${kind}:${identity}:${sessionId}`;
}

async function fetchCatalogModels(
  authAudienceKey: string,
  modelCatalogUpdatedAt: number | null,
  options: { forceRefresh?: boolean } = {},
): Promise<CatalogFetchResult> {
  const request = await createServiceRequest(STELLA_MODELS_PATH);
  const cacheKey = getCatalogRequestCacheKey(
    request,
    authAudienceKey,
    modelCatalogUpdatedAt,
  );
  const cachedCatalog = catalogCache.get(cacheKey);
  if (
    ENABLE_CATALOG_CACHE &&
    cachedCatalog &&
    !options.forceRefresh &&
    isCatalogCacheFresh(cachedCatalog)
  ) {
    lastSeenCatalog = {
      models: cachedCatalog.models,
      defaults: cachedCatalog.defaults,
    };
    return {
      models: cachedCatalog.models,
      defaults: cachedCatalog.defaults,
      error: null,
      stale: false,
    };
  }

  if (options.forceRefresh) {
    inFlightCatalogRequests.delete(cacheKey);
  }

  let inFlightCatalogRequest = inFlightCatalogRequests.get(cacheKey);
  if (!inFlightCatalogRequest) {
    const requestPromise = (async () => {
      try {
        const res = await fetch(request.endpoint, { headers: request.headers });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as CatalogApiResponse;
        const models = normalizeStellaCatalogModels(data?.data ?? []);
        const result = {
          models,
          defaults: data.defaults ?? [],
        };

        if (ENABLE_CATALOG_CACHE && result.models.length > 0) {
          catalogCache.set(cacheKey, {
            models: result.models,
            defaults: result.defaults,
            fetchedAt: Date.now(),
          });
          lastSeenCatalog = {
            models: result.models,
            defaults: result.defaults,
          };
        }

        return {
          models: result.models,
          defaults: result.defaults,
          error: null,
          stale: false,
        };
      } catch (error) {
        const staleCatalog = catalogCache.get(cacheKey);
        if (staleCatalog) {
          return {
            models: staleCatalog.models,
            defaults: staleCatalog.defaults,
            error: toErrorMessage(error),
            stale: true,
          };
        }
        return {
          models: [],
          defaults: [],
          error: toErrorMessage(error),
          stale: false,
        };
      } finally {
        inFlightCatalogRequests.delete(cacheKey);
      }
    })();
    inFlightCatalogRequest = requestPromise;
    inFlightCatalogRequests.set(cacheKey, inFlightCatalogRequest);
  }

  return inFlightCatalogRequest;
}

async function fetchManagedGatewayCatalogModels(
  forceRefresh = false,
): Promise<{ directModels: CatalogModel[]; stellaModels: CatalogModel[] }> {
  if (forceRefresh) {
    managedGatewayCatalogCache = null;
    inFlightManagedGatewayCatalogRequest = null;
  }
  if (
    ENABLE_CATALOG_CACHE &&
    managedGatewayCatalogCache &&
    isCatalogCacheFresh(managedGatewayCatalogCache)
  ) {
    return {
      directModels: managedGatewayCatalogCache.directModels,
      stellaModels: managedGatewayCatalogCache.stellaModels,
    };
  }
  if (!inFlightManagedGatewayCatalogRequest) {
    inFlightManagedGatewayCatalogRequest = (async () => {
      try {
        const res = await fetch(MODELS_DEV_API_URL);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as ModelsDevApi;
        const directModels = normalizeDirectProviderCatalogModels(data);
        const stellaModels = normalizeManagedGatewayCatalogModels(data);
        if (ENABLE_CATALOG_CACHE) {
          managedGatewayCatalogCache = {
            directModels,
            stellaModels,
            fetchedAt: Date.now(),
          };
        }
        return {
          directModels,
          stellaModels,
        };
      } catch {
        return managedGatewayCatalogCache
          ? {
              directModels: managedGatewayCatalogCache.directModels,
              stellaModels: managedGatewayCatalogCache.stellaModels,
            }
          : {
              directModels: [],
              stellaModels: [],
            };
      } finally {
        inFlightManagedGatewayCatalogRequest = null;
      }
    })();
  }
  return inFlightManagedGatewayCatalogRequest;
}

export function useModelCatalog() {
  const session = useDesktopAuthSession();
  // Read the catalog updated-at from the shared provider rather than
  // opening a second `useQuery` subscription — `__root.tsx` already
  // mounts `ModelCatalogUpdatedAtProvider` for the whole tree.
  const modelCatalogUpdatedAt = useModelCatalogUpdatedAt();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasConnectedAccount = Boolean(
    sessionData && user?.isAnonymous !== true,
  );
  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatus | undefined;
  const billingAudienceKey = getBillingAudienceKey(billingStatus);
  const audience = useMemo<ManagedModelAudience | null>(
    () =>
      resolveBillingAudience({
        hasConnectedAccount,
        billingStatus,
      }),
    [billingStatus, hasConnectedAccount],
  );
  const authAudienceKey = useMemo(() => {
    if (session.isPending) {
      return null;
    }
    const sessionKey = getSessionCacheKey(sessionData);
    if (!hasConnectedAccount) {
      return `${sessionKey}:audience:anonymous`;
    }
    if (!billingAudienceKey) {
      return null;
    }
    return `${sessionKey}:audience:${billingAudienceKey}`;
  }, [billingAudienceKey, hasConnectedAccount, sessionData, session.isPending]);
  const [models, setModels] = useState<CatalogModel[]>(
    () => lastSeenCatalog?.models ?? [],
  );
  const [managedGatewayStellaModels, setManagedGatewayStellaModels] = useState<
    CatalogModel[]
  >(() => managedGatewayCatalogCache?.stellaModels ?? []);
  const [directProviderModels, setDirectProviderModels] = useState<
    CatalogModel[]
  >(() => managedGatewayCatalogCache?.directModels ?? []);
  const [defaults, setDefaults] = useState<CatalogDefaultModel[]>(
    () => lastSeenCatalog?.defaults ?? [],
  );
  const [loading, setLoading] = useState(
    () => (lastSeenCatalog?.models.length ?? 0) === 0,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const localModels = useMemo(() => listLocalCatalogModels(), []);
  const stellaModels = useMemo(
    () => mergeCatalogModels(models, managedGatewayStellaModels),
    [managedGatewayStellaModels, models],
  );
  const directModels = useMemo(
    () => mergeCatalogModels(localModels, directProviderModels),
    [directProviderModels, localModels],
  );
  const mergedModels = useMemo(
    () => mergeCatalogModels(stellaModels, directModels),
    [directModels, stellaModels],
  );
  const groups = useMemo<ProviderGroup[]>(
    () => groupCatalogModelsByProvider(mergedModels),
    [mergedModels],
  );
  const searchModels = useMemo(
    () => (query: string) => searchCatalogModels(mergedModels, query),
    [mergedModels],
  );

  useEffect(() => {
    if (!authAudienceKey || modelCatalogUpdatedAt === null) {
      setLoading(true);
      return;
    }
    const activeAuthAudienceKey = authAudienceKey;
    let canceled = false;

    async function fetchCatalog() {
      setLoading(true);
      const result = await fetchCatalogModels(
        activeAuthAudienceKey,
        modelCatalogUpdatedAt,
      );
      if (!canceled) {
        if (result.models.length > 0 || result.defaults.length > 0) {
          setModels(result.models);
          setDefaults(result.defaults);
        }
        setError(result.error);
      }
      if (!canceled) setLoading(false);
    }

    fetchCatalog();
    return () => {
      canceled = true;
    };
  }, [authAudienceKey, modelCatalogUpdatedAt]);

  useEffect(() => {
    let canceled = false;
    void fetchManagedGatewayCatalogModels().then((next) => {
      if (!canceled) {
        setManagedGatewayStellaModels(next.stellaModels);
        setDirectProviderModels(next.directModels);
      }
    });
    return () => {
      canceled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!authAudienceKey || modelCatalogUpdatedAt === null) return;
    setRefreshing(true);
    catalogCache.delete(
      getCatalogRequestCacheKey(
        await createServiceRequest(STELLA_MODELS_PATH),
        authAudienceKey,
        modelCatalogUpdatedAt,
      ),
    );
    try {
      const [catalogResult, managedModels] = await Promise.all([
        fetchCatalogModels(authAudienceKey, modelCatalogUpdatedAt, {
          forceRefresh: true,
        }),
        fetchManagedGatewayCatalogModels(true),
      ]);
      if (
        catalogResult.models.length > 0 ||
        catalogResult.defaults.length > 0
      ) {
        setModels(catalogResult.models);
        setDefaults(catalogResult.defaults);
      }
      setManagedGatewayStellaModels(managedModels.stellaModels);
      setDirectProviderModels(managedModels.directModels);
      setError(catalogResult.error);
    } finally {
      setRefreshing(false);
    }
  }, [authAudienceKey, modelCatalogUpdatedAt]);

  return {
    models: stellaModels,
    stellaModels,
    localModels: directModels,
    allModels: mergedModels,
    defaults,
    groups,
    loading,
    error,
    searchModels,
    modelCatalogUpdatedAt,
    refresh,
    refreshing,
    audience,
  };
}
