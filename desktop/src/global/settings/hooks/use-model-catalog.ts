import { useCallback, useMemo } from "react";
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
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

type StellaCatalogPayload = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
};

type ManagedGatewayPayload = {
  directModels: CatalogModel[];
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

const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_API_URL = "https://models.dev/api.json";

const EMPTY_STELLA: StellaCatalogPayload = { models: [], defaults: [] };
const EMPTY_MANAGED: ManagedGatewayPayload = {
  directModels: [],
};

/**
 * Per-(audience, catalog-version) Stella catalog. Keyed by
 * `${authAudienceKey}::${modelCatalogUpdatedAt}` — the service-request
 * endpoint and device id come from `createServiceRequest` inside the
 * fetcher and don't shift within a renderer-process session, so they
 * don't need to participate in the cache key.
 */
const stellaCatalogStore = createResourceStore<string, StellaCatalogPayload>({
  staleMs: MODEL_CATALOG_REFRESH_INTERVAL_MS,
  fetcher: async () => {
    const request = await createServiceRequest(STELLA_MODELS_PATH);
    const res = await fetch(request.endpoint, { headers: request.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CatalogApiResponse;
    return {
      models: normalizeStellaCatalogModels(data?.data ?? []),
      defaults: data.defaults ?? [],
    };
  },
});

/**
 * Single-key (audience-independent) cache for the public models.dev catalog
 * that powers the Direct Provider rows.
 */
const managedGatewayStore = createResourceStore<"default", ManagedGatewayPayload>({
  staleMs: MODEL_CATALOG_REFRESH_INTERVAL_MS,
  fetcher: async () => {
    const res = await fetch(MODELS_DEV_API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ModelsDevApi;
    return {
      directModels: normalizeDirectProviderCatalogModels(data),
    };
  },
});

function getBillingAudienceKey(
  billingStatus: BillingStatus | undefined,
): string | null {
  if (!billingStatus) return null;
  const { plan, usage } = billingStatus;
  if (plan === "free") return "free";
  const isDowngraded =
    usage.rollingUsedUsd >= usage.rollingLimitUsd ||
    usage.weeklyUsedUsd >= usage.weeklyLimitUsd ||
    usage.monthlyUsedUsd >= usage.monthlyLimitUsd;
  return isDowngraded ? `${plan}_fallback` : plan;
}

function getSessionCacheKey(sessionData: AuthSessionData): string {
  if (!sessionData) return "signed-out";
  const user = sessionData.user;
  const identity =
    user?.id ?? user?.email ?? sessionData.session?.id ?? "unknown";
  const sessionId = sessionData.session?.id ?? "no-session";
  const kind = user?.isAnonymous === true ? "anonymous" : "account";
  return `${kind}:${identity}:${sessionId}`;
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
    if (session.isPending) return null;
    const sessionKey = getSessionCacheKey(sessionData);
    if (!hasConnectedAccount) return `${sessionKey}:audience:anonymous`;
    if (!billingAudienceKey) return null;
    return `${sessionKey}:audience:${billingAudienceKey}`;
  }, [billingAudienceKey, hasConnectedAccount, sessionData, session.isPending]);

  const stellaCacheKey = useMemo(() => {
    if (!authAudienceKey || modelCatalogUpdatedAt === null) return null;
    return `${authAudienceKey}::${modelCatalogUpdatedAt}`;
  }, [authAudienceKey, modelCatalogUpdatedAt]);

  const stellaQuery = useResourceStore(stellaCatalogStore, stellaCacheKey);
  const managedQuery = useResourceStore(managedGatewayStore, "default");

  const stellaPayload = stellaQuery.data ?? EMPTY_STELLA;
  const managedPayload = managedQuery.data ?? EMPTY_MANAGED;

  const localModels = useMemo(() => listLocalCatalogModels(), []);
  const stellaModels = stellaPayload.models;
  const directModels = useMemo(
    () => mergeCatalogModels(localModels, managedPayload.directModels),
    [managedPayload.directModels, localModels],
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

  const refresh = useCallback(async () => {
    await Promise.all([
      stellaQuery.refresh(),
      managedQuery.refresh(),
    ]);
  }, [managedQuery, stellaQuery]);

  const errorMessage =
    stellaQuery.error?.message ?? managedQuery.error?.message ?? null;

  return {
    models: stellaModels,
    stellaModels,
    localModels: directModels,
    allModels: mergedModels,
    defaults: stellaPayload.defaults,
    groups,
    loading:
      stellaCacheKey === null ||
      (stellaQuery.isLoading && stellaPayload.models.length === 0),
    error: errorMessage,
    searchModels,
    modelCatalogUpdatedAt,
    refresh,
    refreshing: stellaQuery.isFetching || managedQuery.isFetching,
    audience,
  };
}
