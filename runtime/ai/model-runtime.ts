import fs from "node:fs";
import path from "node:path";
import { MODELS } from "./models.generated.js";
import {
  ModelConfig,
  getRemoteCatalogModelValidationErrors,
  isRemoteCatalogModel,
  isModelConfigValueConfigured,
  resolveModelConfigHeaders,
  resolveModelConfigValue,
  type ModelsJsonModel,
  type ModelsJsonModelOverride,
  type ModelsJsonProvider,
} from "./model-config.js";
import type { Api, Model } from "./types.js";
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from "../kernel/shared/private-fs.js";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1_000;
// Per provider, measured from the moment that provider's request is dispatched
// rather than from the start of the batch, so one slow endpoint cannot spend
// the budget belonging to the providers queued behind it.
const REMOTE_CATALOG_TIMEOUT_MS = 15_000;
// Every provider catalog lives on the same origin, so firing all of them at
// once just queues them in the connection pool while their deadlines run.
const REMOTE_CATALOG_CONCURRENCY = 6;

/**
 * A bare AbortError reads as "The operation was aborted." no matter why it
 * fired, which made a per-provider timeout indistinguishable from a refresh the
 * caller had torn down. Name the cause instead.
 */
class CatalogRefreshCancelledError extends Error {
  constructor(providerId: string) {
    super(`Model catalog refresh for ${providerId} was cancelled`);
    this.name = "CatalogRefreshCancelledError";
  }
}

const describeCatalogFetchFailure = (
  providerId: string,
  error: unknown,
  causes: { timeoutMs?: number; cancelled: boolean },
): Error => {
  // A lifecycle teardown wins over the deadline: if both fired, the refresh was
  // going away regardless and reporting a timeout would be misleading.
  if (causes.cancelled) return new CatalogRefreshCancelledError(providerId);
  if (causes.timeoutMs !== undefined) {
    return new Error(
      `Model catalog request for ${providerId} timed out after ${causes.timeoutMs}ms`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
};


type StoredCatalogEntry = {
  models: Model<Api>[];
  checkedAt?: number;
};

type PersistedCatalogEntry = {
  models: unknown[];
  checkedAt?: number;
};

type StoredCatalogs = Record<string, PersistedCatalogEntry>;

export type RuntimeProviderDefinition = {
  name: string;
  api: string;
  baseUrl: string;
  apiKeyEnv?: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning?: boolean;
    input?: string[];
    cost?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  }>;
  headers?: Record<string, string>;
};

export type ModelRuntimeSnapshot = {
  revision: number;
  models: Model<Api>[];
  runtimeManagedProviders: Array<{
    id: string;
    authManaged: boolean;
    credentialless: boolean;
  }>;
  refreshedAt: number | null;
  configError?: string;
  catalogError?: string;
};

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "x-goog-api-key",
]);

const hasStaticAuthHeader = (
  headers: Record<string, string> | undefined,
): boolean =>
  Object.entries(headers ?? {}).some(
    ([name, value]) => AUTH_HEADER_NAMES.has(name.toLowerCase()) && Boolean(value),
  );

const cloneModel = (model: Model<Api>): Model<Api> => structuredClone(model);

const modelMap = (models: readonly Model<Api>[]): Map<string, Model<Api>> =>
  new Map(models.map((model) => [model.id, cloneModel(model)]));

const validateRemoteCatalogModels = (
  providerId: string,
  entries: readonly unknown[],
  source: "cache" | "network",
): {
  models: Model<Api>[];
  validCount: number;
  invalidCount: number;
} => {
  const models: Model<Api>[] = [];
  let invalidCount = 0;
  for (const [entryIndex, entry] of entries.entries()) {
    if (!isRemoteCatalogModel(entry, providerId)) {
      invalidCount += 1;
      const modelId =
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        typeof entry.id === "string"
          ? entry.id
          : undefined;
      console.warn(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        {
          providerId,
          source,
          entryIndex,
          ...(modelId ? { modelId } : {}),
          errors: getRemoteCatalogModelValidationErrors(entry, providerId),
        },
      );
      continue;
    }
    models.push({ ...entry, provider: providerId });
  }
  return { models, validCount: models.length, invalidCount };
};

export const mergeModelHeaders = (
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!base && !override) return undefined;
  const merged: Record<string, string> = {};
  for (const headers of [base, override]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      const outputName =
        name.toLowerCase() === "authorization" ? "Authorization" : name;
      const existing = Object.keys(merged).find(
        (candidate) => candidate.toLowerCase() === outputName.toLowerCase(),
      );
      if (existing !== undefined) delete merged[existing];
      merged[outputName] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

const mergeModelCompat = (
  base: Model<Api>["compat"],
  override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] => {
  if (!override) return base;
  const merged = { ...base, ...override } as NonNullable<
    Model<Api>["compat"]
  >;
  const baseNested = base as Record<string, unknown> | undefined;
  const overrideNested = override as Record<string, unknown>;
  const mergedNested = merged as Record<string, unknown>;
  for (const key of [
    "openRouterRouting",
    "vercelGatewayRouting",
    "chatTemplateKwargs",
  ] as const) {
    const baseValue = baseNested?.[key];
    const overrideValue = overrideNested[key];
    if (
      (typeof baseValue === "object" && baseValue !== null) ||
      (typeof overrideValue === "object" && overrideValue !== null)
    ) {
      mergedNested[key] = {
        ...(baseValue as object | undefined),
        ...(overrideValue as object | undefined),
      };
    }
  }
  return merged;
};

const applyModelOverride = (
  model: Model<Api>,
  override: ModelsJsonModelOverride | undefined,
): Model<Api> => {
  if (!override) return model;
  const { headers: _rawHeaders, ...safeOverride } = override;
  return {
    ...model,
    ...safeOverride,
    thinkingLevelMap: override.thinkingLevelMap
      ? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
      : model.thinkingLevelMap,
    cost: override.cost ? { ...model.cost, ...override.cost } : model.cost,
    compat: mergeModelCompat(model.compat, override.compat),
  };
};

const createConfiguredModel = (
  providerId: string,
  provider: ModelsJsonProvider,
  definition: ModelsJsonModel,
  transportDefaults?: Model<Api>,
  metadataDefaults?: Model<Api>,
): Model<Api> => {
  const api =
    definition.api ??
    provider.api ??
    metadataDefaults?.api ??
    transportDefaults?.api;
  const baseUrl =
    definition.baseUrl ??
    provider.baseUrl ??
    metadataDefaults?.baseUrl ??
    transportDefaults?.baseUrl;
  if (!api || !baseUrl) {
    throw new Error(
      `Provider "${providerId}" model "${definition.id}" requires api and baseUrl.`,
    );
  }
  return {
    id: definition.id,
    name: definition.name ?? metadataDefaults?.name ?? definition.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? metadataDefaults?.reasoning ?? false,
    thinkingLevelMap: definition.thinkingLevelMap
      ? { ...metadataDefaults?.thinkingLevelMap, ...definition.thinkingLevelMap }
      : metadataDefaults?.thinkingLevelMap,
    input: definition.input ?? metadataDefaults?.input ?? ["text"],
    cost: {
      input: definition.cost?.input ?? metadataDefaults?.cost.input ?? 0,
      output: definition.cost?.output ?? metadataDefaults?.cost.output ?? 0,
      cacheRead: definition.cost?.cacheRead ?? metadataDefaults?.cost.cacheRead ?? 0,
      cacheWrite: definition.cost?.cacheWrite ?? metadataDefaults?.cost.cacheWrite ?? 0,
    },
    contextWindow:
      definition.contextWindow ?? metadataDefaults?.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? metadataDefaults?.maxTokens ?? 16_384,
    // models.json header expressions remain credential-blind model metadata;
    // they are resolved for each request by getConfiguredHeaders().
    // Preserve only already-composed baseline headers for a same-ID model.
    // models.json header expressions remain request-time-only below.
    headers: metadataDefaults?.headers
      ? { ...metadataDefaults.headers }
      : undefined,
    compat: mergeModelCompat(
      metadataDefaults?.compat ?? provider.compat,
      definition.compat,
    ),
  };
};

const extensionModels = (provider: RuntimeProviderDefinition): Model<Api>[] =>
  provider.models.map((definition) => ({
    id: definition.id,
    name: definition.name,
    api: provider.api as Api,
    provider: provider.name,
    baseUrl: provider.baseUrl,
    reasoning: definition.reasoning ?? false,
    input: (definition.input ?? ["text"]).filter(
      (input): input is "text" | "image" =>
        input === "text" || input === "image",
    ),
    cost: {
      input: definition.cost?.input ?? 0,
      output: definition.cost?.output ?? 0,
      cacheRead: definition.cost?.cacheRead ?? 0,
      cacheWrite: definition.cost?.cacheWrite ?? 0,
    },
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    headers: mergeModelHeaders(undefined, provider.headers),
  }));

export class ModelRuntime {
  private readonly builtins = new Map<string, Model<Api>[]>();
  private readonly dynamicCatalogs = new Map<string, StoredCatalogEntry>();
  private readonly persistedCatalogs = new Map<
    string,
    PersistedCatalogEntry
  >();
  private readonly extensionProviders = new Map<
    string,
    RuntimeProviderDefinition
  >();
  private readonly managedProviderModels = new Map<string, Model<Api>[]>();
  private readonly registeredModels = new Map<
    string,
    Map<string, Model<Api>>
  >();
  private composed = new Map<string, Map<string, Model<Api>>>();
  private config = ModelConfig.empty();
  private modelsPath?: string;
  private storePath?: string;
  private refreshPromise?: Promise<void>;
  private refreshIsForce = false;
  private refreshedAt: number | null = null;
  private compositionErrors: string[] = [];
  private compositionFailedProviders = new Set<string>();
  private catalogError?: string;
  private catalogBaseUrl = DEFAULT_CATALOG_BASE_URL;
  private catalogRequestTimeoutMs = REMOTE_CATALOG_TIMEOUT_MS;
  // Timestamp-derived sequence remains ordered across worker restarts while
  // still allowing multiple registry changes inside one millisecond.
  private revision = Date.now() * 1_000;
  private snapshotFingerprint?: string;
  private readonly catalogChangeListeners = new Set<
    (snapshot: ModelRuntimeSnapshot) => void
  >();

  constructor() {
    for (const [providerId, models] of Object.entries(MODELS)) {
      if (providerId === "grok") continue;
      this.builtins.set(
        providerId,
        Object.values(models).map((model) => cloneModel(model as Model<Api>)),
      );
    }
    this.recompose();
  }

  async initialize(options: {
    stellaDataDir: string;
    allowNetwork?: boolean;
    catalogBaseUrl?: string;
    catalogRequestTimeoutMs?: number;
  }): Promise<void> {
    const revisionBeforeInitialization = this.revision;
    this.modelsPath = path.join(options.stellaDataDir, "models.json");
    this.storePath = path.join(options.stellaDataDir, "models-store.json");
    this.catalogBaseUrl = options.catalogBaseUrl ?? DEFAULT_CATALOG_BASE_URL;
    this.catalogRequestTimeoutMs =
      options.catalogRequestTimeoutMs ?? REMOTE_CATALOG_TIMEOUT_MS;
    this.readStoredCatalogs();
    await this.reloadConfig();
    await this.refresh({ allowNetwork: options.allowNetwork ?? true });
    if (this.revision === revisionBeforeInitialization) {
      this.publishCatalogSnapshot();
    }
  }

  private readStoredCatalogs(): void {
    if (!this.storePath) return;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.storePath, "utf8"),
      ) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      for (const [providerId, entry] of Object.entries(parsed)) {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("models" in entry) ||
          !Array.isArray(entry.models)
        ) {
          continue;
        }
        const checkedAt =
          "checkedAt" in entry && typeof entry.checkedAt === "number"
            ? entry.checkedAt
            : undefined;
        const validation = validateRemoteCatalogModels(
          providerId,
          entry.models,
          "cache",
        );
        this.persistedCatalogs.set(providerId, {
          models: structuredClone(entry.models),
          checkedAt,
        });
        this.dynamicCatalogs.set(providerId, {
          models: validation.models,
          checkedAt: validation.invalidCount > 0 ? undefined : checkedAt,
        });
      }
    } catch {
      // Missing/corrupt cache falls back to the built-in catalog.
    }
  }

  private writeStoredCatalogs(): void {
    if (!this.storePath) return;
    const stored = Object.fromEntries(this.persistedCatalogs) as StoredCatalogs;
    ensurePrivateDirSync(path.dirname(this.storePath));
    writePrivateFileSync(this.storePath, JSON.stringify(stored, null, 2));
  }

  private recompose(): void {
    const providerIds = new Set<string>([
      ...this.builtins.keys(),
      ...this.dynamicCatalogs.keys(),
      ...this.config.getProviderIds(),
      ...this.extensionProviders.keys(),
      ...this.managedProviderModels.keys(),
      ...this.registeredModels.keys(),
    ]);
    const next = new Map<string, Map<string, Model<Api>>>();
    const compositionErrors: string[] = [];
    const compositionFailedProviders = new Set<string>();

    for (const providerId of providerIds) {
      const composeProvider = (
        providerConfig: ModelsJsonProvider | undefined,
      ): Map<string, Model<Api>> => {
        const models = modelMap(this.builtins.get(providerId) ?? []);
        for (const dynamic of this.dynamicCatalogs.get(providerId)?.models ??
          []) {
          models.set(
            dynamic.id,
            cloneModel({ ...dynamic, provider: providerId }),
          );
        }
        for (const managed of this.managedProviderModels.get(providerId) ??
          []) {
          models.set(
            managed.id,
            cloneModel({ ...managed, provider: providerId }),
          );
        }

        if (providerConfig) {
          for (const [modelId, model] of models) {
            models.set(modelId, {
              ...model,
              api: providerConfig.api ?? model.api,
              baseUrl: providerConfig.baseUrl ?? model.baseUrl,
              compat: mergeModelCompat(model.compat, providerConfig.compat),
            });
          }
          for (const definition of providerConfig.models ?? []) {
            const metadataDefaults = models.get(definition.id);
            const transportDefaults =
              metadataDefaults ?? models.values().next().value;
            models.set(
              definition.id,
              createConfiguredModel(
                providerId,
                providerConfig,
                definition,
                transportDefaults,
                metadataDefaults,
              ),
            );
          }
        }

        const extension = this.extensionProviders.get(providerId);
        if (extension) {
          for (const model of extensionModels(extension)) {
            models.set(model.id, model);
          }
        }

        for (const model of this.registeredModels.get(providerId)?.values() ??
          []) {
          models.set(model.id, cloneModel(model));
        }

        if (providerConfig?.modelOverrides) {
          for (const [modelId, override] of Object.entries(
            providerConfig.modelOverrides,
          )) {
            const model = models.get(modelId);
            if (model) {
              models.set(modelId, applyModelOverride(model, override));
            }
          }
        }
        return models;
      };

      const providerConfig = this.config.getProvider(providerId);
      let models: Map<string, Model<Api>>;
      try {
        models = composeProvider(providerConfig);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        compositionErrors.push(
          `models.json Provider "${providerId}": ${detail}`,
        );
        compositionFailedProviders.add(providerId);
        models = composeProvider(undefined);
      }
      if (models.size > 0) next.set(providerId, models);
    }
    this.composed = next;
    this.compositionErrors = compositionErrors;
    this.compositionFailedProviders = compositionFailedProviders;
    this.publishCatalogChangeIfNeeded();
  }

  private publishCatalogChangeIfNeeded(): void {
    const snapshot = this.getSnapshot();
    const fingerprint = JSON.stringify({ ...snapshot, revision: undefined });
    if (fingerprint === this.snapshotFingerprint) return;
    this.snapshotFingerprint = fingerprint;
    this.publishCatalogSnapshot();
  }

  private publishCatalogSnapshot(): void {
    this.revision += 1;
    const published = this.getSnapshot();
    for (const listener of this.catalogChangeListeners) {
      try {
        listener(published);
      } catch {
        // Registry writes must not fail because a detached host cannot receive
        // its best-effort picker notification.
      }
    }
  }

  onCatalogChanged(
    listener: (snapshot: ModelRuntimeSnapshot) => void,
  ): () => void {
    this.catalogChangeListeners.add(listener);
    return () => this.catalogChangeListeners.delete(listener);
  }

  async reloadConfig(): Promise<void> {
    this.config = await ModelConfig.load(this.modelsPath);
    this.recompose();
  }

  setExtensionProviders(providers: readonly RuntimeProviderDefinition[]): void {
    this.extensionProviders.clear();
    for (const provider of providers) {
      this.extensionProviders.set(provider.name, structuredClone(provider));
    }
    this.recompose();
  }

  setManagedProviderModels(
    providerId: string,
    models: readonly Model<Api>[],
  ): void {
    this.managedProviderModels.set(
      providerId,
      models.map((model) => cloneModel({ ...model, provider: providerId })),
    );
    this.recompose();
  }

  registerModel(providerId: string, model: Model<Api>): void {
    const models = this.registeredModels.get(providerId) ?? new Map();
    models.set(model.id, cloneModel(model));
    this.registeredModels.set(providerId, models);
    this.recompose();
  }

  unregisterModel(providerId: string, modelId: string): void {
    const models = this.registeredModels.get(providerId);
    if (!models) return;
    models.delete(modelId);
    if (models.size === 0) this.registeredModels.delete(providerId);
    this.recompose();
  }

  private async refreshProvider(
    providerId: string,
    options: { force?: boolean; lifecycleSignal?: AbortSignal },
  ): Promise<void> {
    const stored = this.dynamicCatalogs.get(providerId);
    if (
      !options.force &&
      stored?.checkedAt !== undefined &&
      Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    const timeoutSignal = AbortSignal.timeout(this.catalogRequestTimeoutMs);
    const signal = options.lifecycleSignal
      ? AbortSignal.any([options.lifecycleSignal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(
        new URL(
          `/api/models/providers/${encodeURIComponent(providerId)}`,
          this.catalogBaseUrl,
        ),
        { headers: { accept: "application/json" }, signal },
      );
      // Reading the body can abort too, so it shares the request's deadline.
      payload = response.ok ? ((await response.json()) as unknown) : undefined;
    } catch (error) {
      throw describeCatalogFetchFailure(providerId, error, {
        timeoutMs: timeoutSignal.aborted
          ? this.catalogRequestTimeoutMs
          : undefined,
        cancelled: options.lifecycleSignal?.aborted === true,
      });
    }
    const checkedAt = Date.now();
    if (response.status === 404 || response.status === 501) {
      this.dynamicCatalogs.set(providerId, {
        models: stored?.models ?? [],
        checkedAt,
      });
      this.persistedCatalogs.set(providerId, {
        models: structuredClone(
          this.persistedCatalogs.get(providerId)?.models ?? stored?.models ?? [],
        ),
        checkedAt,
      });
      return;
    }
    if (!response.ok) {
      throw new Error(
        `Model catalog request failed for ${providerId}: ${response.status}`,
      );
    }
    const entries = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && "models" in payload
        ? (payload as { models?: unknown }).models
        : payload && typeof payload === "object"
          ? Object.values(payload)
          : [];
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid model catalog for ${providerId}`);
    }
    const validation = validateRemoteCatalogModels(
      providerId,
      entries,
      "network",
    );
    if (entries.length > 0 && validation.validCount === 0) {
      throw new Error(
        `Invalid model catalog for ${providerId}: non-empty payload contained ${validation.invalidCount} invalid ${validation.invalidCount === 1 ? "entry" : "entries"} and no valid entries`,
      );
    }
    this.dynamicCatalogs.set(providerId, {
      models: validation.models,
      checkedAt,
    });
    this.persistedCatalogs.set(providerId, {
      models: validation.models.map(cloneModel),
      checkedAt,
    });
  }

  /**
   * Fans the providers out over a bounded pool and returns one
   * `"<provider>: <reason>"` line per failure. Each provider carries its own
   * deadline, so a hanging endpoint fails alone instead of taking the rest of
   * the batch down with it.
   */
  private async refreshProviders(
    providerIds: string[],
    options: { force?: boolean; signal?: AbortSignal },
  ): Promise<string[]> {
    const failures: string[] = [];
    let cursor = 0;
    const runWorker = async (): Promise<void> => {
      while (cursor < providerIds.length && !options.signal?.aborted) {
        const providerId = providerIds[cursor++]!;
        try {
          await this.refreshProvider(providerId, {
            force: options.force,
            lifecycleSignal: options.signal,
          });
        } catch (error) {
          if (error instanceof CatalogRefreshCancelledError) continue;
          failures.push(
            `${providerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(REMOTE_CATALOG_CONCURRENCY, providerIds.length) },
        runWorker,
      ),
    );
    return failures;
  }

  async refresh(
    options: {
      allowNetwork?: boolean;
      force?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (this.refreshPromise) {
      const activeRefresh = this.refreshPromise;
      if (options.force && !this.refreshIsForce) {
        return activeRefresh.then(
          () => this.refresh(options),
          () => this.refresh(options),
        );
      }
      return activeRefresh;
    }
    this.refreshIsForce = options.force === true;
    this.refreshPromise = (async () => {
      if (options.allowNetwork !== false) {
        const providerIds = [...this.builtins.keys()].filter(
          (providerId) => providerId !== "local",
        );
        const failures = await this.refreshProviders(providerIds, options);
        // A torn-down refresh is not a catalog failure. Report nothing rather
        // than one scary line per provider that never got its turn, and leave
        // the previous error in place as the last thing we actually learned.
        if (options.signal?.aborted) return;
        const successCount = providerIds.length - failures.length;
        this.catalogError =
          failures.length > 0
            ? `Model catalog refresh failed for ${failures.join("; ")}`
            : undefined;
        if (successCount === 0 && failures.length > 0) {
          this.publishCatalogChangeIfNeeded();
          throw new Error(this.catalogError);
        }
        if (successCount > 0) {
          this.refreshedAt = Date.now();
          this.writeStoredCatalogs();
        }
      }
      this.recompose();
    })().finally(() => {
      this.refreshPromise = undefined;
      this.refreshIsForce = false;
    });
    return this.refreshPromise;
  }

  async getSnapshotForListing(options: {
    forceRefresh?: boolean;
  } = {}): Promise<ModelRuntimeSnapshot> {
    await this.reloadConfig();
    if (options.forceRefresh) {
      await this.refresh({ allowNetwork: true, force: true });
    } else {
      void this.refresh({ allowNetwork: true }).catch(() => undefined);
    }
    return this.getSnapshot();
  }

  getModels(providerId: string): Model<Api>[] {
    return [...(this.composed.get(providerId)?.values() ?? [])].map(cloneModel);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    const model = this.composed.get(providerId)?.get(modelId);
    return model ? cloneModel(model) : undefined;
  }

  getAllModels(): Model<Api>[] {
    return [...this.composed.values()].flatMap((models) =>
      [...models.values()].map(cloneModel),
    );
  }

  getProviderIds(): string[] {
    return [...this.composed.keys()].sort();
  }

  isRegisteredReference(reference: string): boolean {
    const normalized = reference.trim();
    if (!normalized) return false;
    for (const [providerId, models] of this.composed) {
      for (const model of models.values()) {
        if (
          normalized === model.id ||
          normalized === `${providerId}/${model.id}` ||
          normalized === `${model.provider}/${model.id}`
        ) {
          return true;
        }
      }
    }
    return false;
  }

  getConfiguredApiKey(providerId: string): string | undefined {
    return resolveModelConfigValue(
      this.compositionFailedProviders.has(providerId)
        ? undefined
        : this.config.getProvider(providerId)?.apiKey,
    );
  }

  hasConfiguredApiKey(providerId: string): boolean {
    return isModelConfigValueConfigured(
      this.compositionFailedProviders.has(providerId)
        ? undefined
        : this.config.getProvider(providerId)?.apiKey,
    );
  }

  hasRuntimeManagedAuth(providerId: string): boolean {
    const extension = this.extensionProviders.get(providerId);
    const provider = this.compositionFailedProviders.has(providerId)
      ? undefined
      : this.config.getProvider(providerId);
    return (
      provider?.apiKey !== undefined ||
      hasStaticAuthHeader(provider?.headers) ||
      provider?.models?.some((model) => hasStaticAuthHeader(model.headers)) ||
      Object.values(provider?.modelOverrides ?? {}).some((override) =>
        hasStaticAuthHeader(override.headers),
      ) ||
      Boolean(extension?.apiKeyEnv) ||
      hasStaticAuthHeader(extension?.headers)
    );
  }

  hasRuntimeProviderOrigin(providerId: string): boolean {
    return (
      !this.compositionFailedProviders.has(providerId) &&
      (this.config.getProvider(providerId) !== undefined ||
        this.extensionProviders.has(providerId))
    );
  }

  allowsCredentiallessRouting(providerId: string): boolean {
    const provider = this.compositionFailedProviders.has(providerId)
      ? undefined
      : this.config.getProvider(providerId);
    if (
      this.builtins.has(providerId) ||
      !this.hasRuntimeProviderOrigin(providerId) ||
      provider?.authHeader === true ||
      this.hasRuntimeManagedAuth(providerId)
    ) {
      return false;
    }
    return true;
  }

  getRuntimeManagedApiKey(providerId: string): string | undefined {
    const configured = this.compositionFailedProviders.has(providerId)
      ? undefined
      : this.config.getProvider(providerId)?.apiKey;
    if (configured !== undefined) {
      const apiKey = resolveModelConfigValue(configured);
      if (!apiKey) {
        throw new Error(
          `Required models.json API key for provider "${providerId}" could not be resolved.`,
        );
      }
      return apiKey;
    }
    const extension = this.extensionProviders.get(providerId);
    if (!extension?.apiKeyEnv) return undefined;
    const apiKey = process.env[extension.apiKeyEnv]?.trim();
    if (!apiKey) {
      throw new Error(
        `Extension provider "${providerId}" requires environment variable "${extension.apiKeyEnv}".`,
      );
    }
    return apiKey;
  }

  usesConfiguredAuthHeader(providerId: string): boolean {
    return (
      !this.compositionFailedProviders.has(providerId) &&
      this.config.getProvider(providerId)?.authHeader === true
    );
  }

  getConfiguredHeaders(
    providerId: string,
    modelId: string,
  ): Record<string, string> | undefined {
    const provider = this.compositionFailedProviders.has(providerId)
      ? undefined
      : this.config.getProvider(providerId);
    const providerHeaders = resolveModelConfigHeaders(
      provider?.headers,
      `provider "${providerId}"`,
    );
    const definitionHeaders = resolveModelConfigHeaders(
      provider?.models?.find((model) => model.id === modelId)?.headers,
      `model "${providerId}/${modelId}"`,
    );
    const modelHeaders = resolveModelConfigHeaders(
      provider?.modelOverrides?.[modelId]?.headers,
      `model "${providerId}/${modelId}"`,
    );
    const headers = mergeModelHeaders(
      mergeModelHeaders(providerHeaders, definitionHeaders),
      modelHeaders,
    );
    return headers;
  }

  getSnapshot(): ModelRuntimeSnapshot {
    return {
      revision: this.revision,
      models: this.getAllModels().map((model) => {
        const { headers: _headers, ...safeModel } = model;
        return safeModel as Model<Api>;
      }),
      runtimeManagedProviders: [
        ...new Set<string>([
          ...this.config
            .getProviderIds()
            .filter(
              (providerId) =>
                !this.compositionFailedProviders.has(providerId),
            ),
          ...this.extensionProviders.keys(),
          ...this.registeredModels.keys(),
        ]),
      ]
        .sort()
        .map((id) => ({
          id,
          authManaged:
            this.hasRuntimeManagedAuth(id),
          credentialless: this.allowsCredentiallessRouting(id),
        })),
      refreshedAt: this.refreshedAt,
      configError: [this.config.getError(), ...this.compositionErrors]
        .filter((error): error is string => Boolean(error))
        .join("\n") || undefined,
      catalogError: this.catalogError,
    };
  }
}

export const modelRuntime = new ModelRuntime();
