import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@/convex/api";
import { authClient } from "@/global/auth/lib/auth-client";
import { createServiceRequest } from "@/infra/http/service-request";
import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
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

type CatalogFetchResult = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
  error: string | null;
  stale: boolean;
};

type AuthSessionData = {
  user?: {
    id?: string | null;
    email?: string | null;
    isAnonymous?: boolean | null;
  } | null;
  session?: {
    id?: string | null;
  } | null;
} | null | undefined;

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
};

const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";

const inFlightCatalogRequests = new Map<string, Promise<CatalogFetchResult>>();
const catalogCache = new Map<string, CatalogCacheEntry>();
const MODELS_DEV_API_URL = "https://models.dev/api.json";
let managedGatewayCatalogCache: CatalogModel[] | null = null;
let inFlightManagedGatewayCatalogRequest: Promise<CatalogModel[]> | null = null;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "Unable to load model catalog.";

function getJwtCacheIdentity(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    return "auth:none";
  }
  const token = authorization.slice("Bearer ".length);
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? "")) as Record<
      string,
      unknown
    >;
    const issuer = typeof payload.iss === "string" ? payload.iss : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const tokenIdentifier =
      typeof payload.tokenIdentifier === "string"
        ? payload.tokenIdentifier
        : "";
    const audience = Array.isArray(payload.aud)
      ? payload.aud.join(",")
      : typeof payload.aud === "string"
        ? payload.aud
        : "";
    const isAnonymous =
      typeof payload.isAnonymous === "boolean"
        ? String(payload.isAnonymous)
        : "";
    return [
      "auth:jwt",
      issuer,
      subject,
      tokenIdentifier,
      audience,
      isAnonymous,
    ].join(":");
  } catch {
    return "auth:jwt-unreadable";
  }
}

function getCatalogRequestCacheKey(
  request: Awaited<ReturnType<typeof createServiceRequest>>,
  authAudienceKey: string,
  modelCatalogUpdatedAt: number | null,
): string {
  return [
    request.endpoint,
    authAudienceKey,
    `modelCatalogUpdatedAt:${modelCatalogUpdatedAt ?? "none"}`,
    getJwtCacheIdentity(request.headers.Authorization),
    request.headers["X-Device-ID"] ?? "device:none",
  ].join("|");
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
): Promise<CatalogFetchResult> {
  const request = await createServiceRequest(STELLA_MODELS_PATH);
  const cacheKey = getCatalogRequestCacheKey(
    request,
    authAudienceKey,
    modelCatalogUpdatedAt,
  );
  const cachedCatalog = catalogCache.get(cacheKey);
  if (ENABLE_CATALOG_CACHE && cachedCatalog) {
    return {
      models: cachedCatalog.models,
      defaults: cachedCatalog.defaults,
      error: null,
      stale: false,
    };
  }

  let inFlightCatalogRequest = inFlightCatalogRequests.get(cacheKey);
  if (!inFlightCatalogRequest) {
    inFlightCatalogRequest = (async () => {
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
          });
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
    inFlightCatalogRequests.set(cacheKey, inFlightCatalogRequest);
  }

  return inFlightCatalogRequest;
}

async function fetchManagedGatewayCatalogModels(
  forceRefresh = false,
): Promise<CatalogModel[]> {
  if (forceRefresh) {
    managedGatewayCatalogCache = null;
    inFlightManagedGatewayCatalogRequest = null;
  }
  if (ENABLE_CATALOG_CACHE && managedGatewayCatalogCache) {
    return managedGatewayCatalogCache;
  }
  if (!inFlightManagedGatewayCatalogRequest) {
    inFlightManagedGatewayCatalogRequest = (async () => {
      try {
        const res = await fetch(MODELS_DEV_API_URL);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as ModelsDevApi;
        const models = normalizeManagedGatewayCatalogModels(data);
        if (ENABLE_CATALOG_CACHE) {
          managedGatewayCatalogCache = models;
        }
        return models;
      } catch {
        return managedGatewayCatalogCache ?? [];
      } finally {
        inFlightManagedGatewayCatalogRequest = null;
      }
    })();
  }
  return inFlightManagedGatewayCatalogRequest;
}

export function useModelCatalog() {
  const session = authClient.useSession();
  const catalogUpdatedAtQuery = (
    api as unknown as {
      stella_models: {
        getModelCatalogUpdatedAt: FunctionReference<
          "query",
          "public",
          Record<string, never>,
          number
        >;
      };
    }
  ).stella_models.getModelCatalogUpdatedAt;
  const modelCatalogUpdatedAt =
    (useQuery(catalogUpdatedAtQuery, {}) as number | undefined) ?? null;
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasConnectedAccount = Boolean(sessionData && user?.isAnonymous !== true);
  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatus | undefined;
  const billingAudienceKey = getBillingAudienceKey(billingStatus);
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
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [managedGatewayModels, setManagedGatewayModels] = useState<
    CatalogModel[]
  >([]);
  const [defaults, setDefaults] = useState<CatalogDefaultModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const localModels = useMemo(() => listLocalCatalogModels(), []);
  const stellaModels = useMemo(
    () => mergeCatalogModels(models, managedGatewayModels),
    [managedGatewayModels, models],
  );
  const mergedModels = useMemo(
    () => mergeCatalogModels(stellaModels, localModels),
    [localModels, stellaModels],
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
    if (!authAudienceKey) {
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
  }, [authAudienceKey, modelCatalogUpdatedAt, refreshTick]);

  useEffect(() => {
    let canceled = false;
    void fetchManagedGatewayCatalogModels(refreshTick > 0).then((next) => {
      if (!canceled) {
        setManagedGatewayModels(next);
      }
    });
    return () => {
      canceled = true;
    };
  }, [refreshTick]);

  const refresh = useCallback(async () => {
    if (!authAudienceKey) return;
    setRefreshing(true);
    catalogCache.delete(
      getCatalogRequestCacheKey(
        await createServiceRequest(STELLA_MODELS_PATH),
        authAudienceKey,
        modelCatalogUpdatedAt,
      ),
    );
    setRefreshTick((tick) => tick + 1);
    try {
      await Promise.all([
        fetchCatalogModels(authAudienceKey, modelCatalogUpdatedAt),
        fetchManagedGatewayCatalogModels(true),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [authAudienceKey, modelCatalogUpdatedAt]);

  return {
    models: stellaModels,
    stellaModels,
    localModels,
    allModels: mergedModels,
    defaults,
    groups,
    loading,
    error,
    searchModels,
    modelCatalogUpdatedAt,
    refresh,
    refreshing,
  };
}
