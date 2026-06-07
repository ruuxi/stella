import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

/**
 * Shape a lazy provider loader must resolve to. Each provider module
 * exports differently-named `streamX` / `streamSimpleX` symbols, so the
 * loader closure (in `register-builtins.ts`) maps those onto this
 * uniform `{ stream, streamSimple }` shape.
 */
export interface ApiProviderModule<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
> {
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

/**
 * Lazy registration: defer importing the provider's SDK-bearing module
 * (and the heavy SDK graph it pulls in: @anthropic-ai/sdk, openai,
 * @google/genai, @mistralai/mistralai, @aws-sdk/client-bedrock-runtime,
 * …) until the first `stream()`/`streamSimple()` for this api. The
 * resolved module is cached after first load so subsequent calls reuse
 * it without re-importing. This keeps the worker's INTERNAL_WORKER_INITIALIZE
 * boot path off the SDK parse/eval cost.
 */
export interface LazyApiProvider<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
> {
	api: TApi;
	load: () => Promise<ApiProviderModule<TApi, TOptions>>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
	api: Api;
	/**
	 * Resolved internal provider. Present immediately for eager
	 * registrations; populated on first load for lazy registrations and
	 * cached thereafter.
	 */
	resolved?: ApiProviderInternal;
	/**
	 * Lazy loader closure. Undefined for eager registrations. The
	 * in-flight load promise is cached so concurrent first-stream calls
	 * share a single import.
	 */
	load?: () => Promise<ApiProviderInternal>;
	loadPromise?: Promise<ApiProviderInternal>;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

function toInternalProvider<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	module: ApiProviderModule<TApi, TOptions>,
): ApiProviderInternal {
	return {
		api,
		stream: wrapStream(api, module.stream),
		streamSimple: wrapStreamSimple(api, module.streamSimple),
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		api: provider.api,
		resolved: toInternalProvider(provider.api, {
			stream: provider.stream,
			streamSimple: provider.streamSimple,
		}),
		sourceId,
	});
}

/**
 * Register a provider whose SDK-bearing implementation module loads
 * lazily on first stream. See {@link LazyApiProvider}.
 */
export function registerLazyApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: LazyApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	const { api, load } = provider;
	apiProviderRegistry.set(api, {
		api,
		load: async () => toInternalProvider(api, await load()),
		sourceId,
	});
}

/**
 * Synchronously fetch an already-resolved provider. Returns undefined
 * for lazy providers that have not been loaded yet (use
 * {@link resolveApiProviderInternal} to trigger + await the load).
 */
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.resolved;
}

/**
 * Resolve a provider, awaiting (and caching) the lazy load on first use.
 * Returns undefined if no provider is registered for the api.
 */
export async function resolveApiProviderInternal(
	api: Api,
): Promise<ApiProviderInternal | undefined> {
	const entry = apiProviderRegistry.get(api);
	if (!entry) return undefined;
	if (entry.resolved) return entry.resolved;
	if (!entry.load) return undefined;
	if (!entry.loadPromise) {
		entry.loadPromise = entry
			.load()
			.then((resolved) => {
				entry.resolved = resolved;
				return resolved;
			})
			.catch((error) => {
				// Allow a later call to retry the import rather than caching
				// the rejection forever.
				entry.loadPromise = undefined;
				throw error;
			});
	}
	return entry.loadPromise;
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.resolved).filter(
		(provider): provider is ApiProviderInternal => provider !== undefined,
	);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
