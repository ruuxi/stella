import { useState, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { authClient } from "@/global/auth/lib/auth-client";
import { createServiceRequest } from "@/infra/http/service-request";
import { STELLA_MODELS_PATH } from "@/shared/stella-api";

type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  upstreamModel?: string;
};

type CatalogDefaultModel = {
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
  expiresAt: number;
};

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_CATALOG_CACHE = import.meta.env.MODE !== "test";

const inFlightCatalogRequests = new Map<string, Promise<CatalogFetchResult>>();
const catalogCache = new Map<string, CatalogCacheEntry>();

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
): string {
  return [
    request.endpoint,
    authAudienceKey,
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
): Promise<CatalogFetchResult> {
  const request = await createServiceRequest(STELLA_MODELS_PATH);
  const cacheKey = getCatalogRequestCacheKey(request, authAudienceKey);
  const cachedCatalog = catalogCache.get(cacheKey);
  if (
    ENABLE_CATALOG_CACHE &&
    cachedCatalog &&
    cachedCatalog.expiresAt > Date.now()
  ) {
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
        const models = (data?.data ?? [])
          .filter((model) => !model.type || model.type === "language")
          .map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            provider: model.provider ?? "stella",
            upstreamModel: model.upstreamModel,
          }));
        const result = {
          models,
          defaults: data.defaults ?? [],
        };

        if (ENABLE_CATALOG_CACHE && result.models.length > 0) {
          catalogCache.set(cacheKey, {
            models: result.models,
            defaults: result.defaults,
            expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
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

export function useModelCatalog() {
  const session = authClient.useSession();
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
  const [defaults, setDefaults] = useState<CatalogDefaultModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupByProvider(models), [models]);

  useEffect(() => {
    if (!authAudienceKey) {
      setLoading(true);
      return;
    }
    const activeAuthAudienceKey = authAudienceKey;
    let canceled = false;

    async function fetchCatalog() {
      setLoading(true);
      const result = await fetchCatalogModels(activeAuthAudienceKey);
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
  }, [authAudienceKey]);

  return { models, defaults, groups, loading, error };
}
