import { MODELS } from "./models.generated.js";
import type { Api, Model, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type RegisteredProvider = keyof typeof MODELS;

type ModelApi<
	TProvider extends RegisteredProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends RegisteredProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getModels<TProvider extends RegisteredProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

/**
 * Register a model at runtime (e.g., from extensions).
 * If the provider doesn't exist in the registry, it is created.
 */
export function registerModel(provider: string, model: Model<Api>): void {
	let providerModels = modelRegistry.get(provider);
	if (!providerModels) {
		providerModels = new Map<string, Model<Api>>();
		modelRegistry.set(provider, providerModels);
	}
	providerModels.set(model.id, model);
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 model families
 * - Anthropic Messages API Opus 4.6 models (xhigh maps to adaptive effort "max")
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.4")) {
		return true;
	}

	if (model.api === "anthropic-messages") {
		return model.id.includes("opus-4-6") || model.id.includes("opus-4.6");
	}

	return false;
}
