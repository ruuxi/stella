import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Api, Model } from "../ai/types.js";
import {
  STELLA_DEFAULT_MODEL,
  STELLA_MODELS_PATH,
  normalizeStellaSiteUrl,
} from "../contracts/stella-api.js";
import { writePrivateFile } from "./shared/private-fs.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import {
  STELLA_PROVIDER,
  createStellaRoute,
  type StellaSiteConfig,
} from "./model-routing-stella.js";

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

type StellaModelCatalog = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
};

type CatalogCacheEntry = StellaModelCatalog;

type ModelIdentity = Pick<Model<Api>, "api" | "provider" | "id" | "name">;

const catalogCache = new Map<string, CatalogCacheEntry>();
const inFlightCatalogRequests = new Map<
  string,
  Promise<StellaModelCatalog | null>
>();

const diskCachePathForKey = (stellaDataDir: string, cacheKey: string): string =>
  path.join(
    stellaDataDir,
    "cache",
    "model-catalog",
    `${createHash("sha256").update(cacheKey).digest("hex")}.json`,
  );

const cloneCatalog = (catalog: StellaModelCatalog): StellaModelCatalog => ({
  models: catalog.models,
  defaults: catalog.defaults,
});

const isCatalogModel = (value: unknown): value is CatalogModel => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CatalogModel>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.provider === "string" &&
    (candidate.upstreamModel === undefined ||
      typeof candidate.upstreamModel === "string")
  );
};

const isCatalogDefault = (value: unknown): value is CatalogDefaultModel => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CatalogDefaultModel>;
  return (
    typeof candidate.agentType === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.resolvedModel === "string"
  );
};

const parsePersistedCatalog = (
  value: unknown,
  cacheKey: string,
): StellaModelCatalog | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    cacheKey?: unknown;
    catalog?: { models?: unknown; defaults?: unknown };
  };
  if (candidate.cacheKey !== cacheKey) return null;
  const models = candidate.catalog?.models;
  const defaults = candidate.catalog?.defaults;
  if (!Array.isArray(models) || !Array.isArray(defaults)) return null;
  if (!models.every(isCatalogModel) || !defaults.every(isCatalogDefault)) {
    return null;
  }
  return { models, defaults };
};

const readCatalogFromDisk = async (
  stellaDataDir: string | undefined,
  cacheKey: string,
): Promise<StellaModelCatalog | null> => {
  if (!stellaDataDir?.trim()) return null;
  try {
    const raw = await fs.readFile(
      diskCachePathForKey(stellaDataDir, cacheKey),
      "utf-8",
    );
    return parsePersistedCatalog(JSON.parse(raw), cacheKey);
  } catch {
    return null;
  }
};

const writeCatalogToDisk = async (
  stellaDataDir: string | undefined,
  cacheKey: string,
  catalog: StellaModelCatalog,
): Promise<void> => {
  if (!stellaDataDir?.trim()) return;
  await writePrivateFile(
    diskCachePathForKey(stellaDataDir, cacheKey),
    JSON.stringify({ cacheKey, catalog }, null, 2),
  );
};

export const invalidateStellaModelCatalogCache = (): void => {
  catalogCache.clear();
  inFlightCatalogRequests.clear();
};

const getJwtCacheIdentity = (authorization: string | undefined): string => {
  if (!authorization?.startsWith("Bearer ")) {
    return "auth:none";
  }
  const token = authorization.slice("Bearer ".length);
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
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
    return `auth:jwt-unreadable:${createHash("sha256").update(token).digest("hex")}`;
  }
};

const buildCatalogRequest = (args: {
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
}): {
  endpoint: string;
  headers: Record<string, string>;
  cacheKey: string;
} | null => {
  const baseUrl = args.site.baseUrl?.trim();
  const authToken = args.site.getAuthToken()?.trim();
  if (!baseUrl || !authToken) {
    return null;
  }

  const endpoint = `${normalizeStellaSiteUrl(baseUrl)}${STELLA_MODELS_PATH}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
  };
  if (args.deviceId?.trim()) {
    headers["X-Device-ID"] = args.deviceId.trim();
  }
  return {
    endpoint,
    headers,
    cacheKey: [
      endpoint,
      getJwtCacheIdentity(headers.Authorization),
      headers["X-Device-ID"] ?? "device:none",
      args.modelCatalogUpdatedAt ?? "model-catalog-updated-at:none",
    ].join("|"),
  };
};

const fetchStellaModelCatalog = async (args: {
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  stellaDataDir?: string;
}): Promise<StellaModelCatalog | null> => {
  const request = buildCatalogRequest(args);
  if (!request) {
    return null;
  }

  const cached = catalogCache.get(request.cacheKey);
  if (cached) {
    return cloneCatalog(cached);
  }

  let inFlight = inFlightCatalogRequests.get(request.cacheKey);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const diskCached = await readCatalogFromDisk(
          args.stellaDataDir,
          request.cacheKey,
        );
        if (diskCached) {
          catalogCache.set(request.cacheKey, diskCached);
          return cloneCatalog(diskCached);
        }
        const res = await fetch(request.endpoint, { headers: request.headers });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as CatalogApiResponse;
        const catalog = {
          models: (data.data ?? [])
            .filter((model) => !model.type || model.type === "language")
            .map((model) => ({
              id: model.id,
              name: model.name ?? model.id,
              provider: model.provider ?? STELLA_PROVIDER,
              upstreamModel: model.upstreamModel,
            })),
          defaults: data.defaults ?? [],
        };
        catalogCache.set(request.cacheKey, cloneCatalog(catalog));
        await writeCatalogToDisk(
          args.stellaDataDir,
          request.cacheKey,
          catalog,
        ).catch(() => undefined);
        return catalog;
      } catch {
        return null;
      } finally {
        inFlightCatalogRequests.delete(request.cacheKey);
      }
    })();
    inFlightCatalogRequests.set(request.cacheKey, inFlight);
  }

  return await inFlight;
};

const modelIdentityFromId = (modelId: string): ModelIdentity => {
  const normalized = modelId.trim();
  const [provider, ...rest] = normalized.split("/");
  const hasProvider = Boolean(provider && rest.length > 0);
  return {
    id: normalized,
    name: hasProvider ? rest.join("/") : normalized,
    provider: hasProvider ? provider : "",
    api: hasProvider ? provider : "",
  };
};

const resolvePassthroughStellaModel = (modelId: string): string | null => {
  const prefix = `${STELLA_PROVIDER}/`;
  if (!modelId.startsWith(prefix)) {
    return null;
  }
  const upstream = modelId.slice(prefix.length);
  return upstream.includes("/") ? upstream : null;
};

const resolveStellaModelAlias = async (args: {
  route: ResolvedLlmRoute;
  agentType: string;
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  stellaDataDir?: string;
}): Promise<string | null> => {
  if (args.route.route !== "stella") {
    return null;
  }

  const modelId = args.route.model.id.trim();
  const passthrough = resolvePassthroughStellaModel(modelId);
  if (passthrough) {
    return passthrough;
  }

  const catalog = await fetchStellaModelCatalog({
    site: args.site,
    deviceId: args.deviceId,
    modelCatalogUpdatedAt: args.modelCatalogUpdatedAt,
    stellaDataDir: args.stellaDataDir,
  });
  if (!catalog) {
    return null;
  }

  if (modelId === STELLA_DEFAULT_MODEL) {
    return (
      catalog.defaults.find((entry) => entry.agentType === args.agentType)
        ?.resolvedModel ?? null
    );
  }

  return (
    catalog.models.find((model) => model.id === modelId)?.upstreamModel ?? null
  );
};

export const withStellaModelCatalogMetadata = async (args: {
  route: ResolvedLlmRoute;
  agentType: string;
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  stellaDataDir?: string;
}): Promise<ResolvedLlmRoute> => {
  if (args.route.route !== "stella") {
    return args.route;
  }

  const resolvedModelId = await resolveStellaModelAlias(args);
  if (!resolvedModelId) {
    return args.route;
  }

  const resolvedRoute = createStellaRoute({
    site: args.site,
    agentType: args.agentType,
    modelId: args.route.model.id,
    resolvedModelId,
  });

  return {
    ...(resolvedRoute ?? args.route),
    toolPolicyModel: modelIdentityFromId(resolvedModelId),
  };
};
