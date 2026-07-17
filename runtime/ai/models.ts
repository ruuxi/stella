import { MODELS } from "./models.generated.js";
import { modelRuntime } from "./model-runtime.js";
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

type RegisteredProvider = keyof typeof MODELS;

type ModelApi<
	TProvider extends RegisteredProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends RegisteredProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	return modelRuntime.getModel(provider, modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getModels<TProvider extends RegisteredProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	return modelRuntime.getModels(provider) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[];
}

export function getModelProviders(): string[] {
	return modelRuntime.getProviderIds();
}

export function getAllModels(): Model<Api>[] {
	return modelRuntime.getAllModels();
}

/**
 * Whether a user-facing model reference names an entry already present in the
 * registry. Both the registry namespace and the model's provider namespace
 * are accepted because routing supports both shapes.
 */
export function isRegisteredModelReference(rawReference: string): boolean {
	return modelRuntime.isRegisteredReference(rawReference);
}

/**
 * Register a model at runtime (e.g., from extensions).
 * If the provider doesn't exist in the registry, it is created.
 */
export function registerModel(provider: string, model: Model<Api>): void {
	modelRuntime.registerModel(provider, model);
}

/**
 * Remove a model from the runtime registry.
 *
 * Used by extension hot-reload so deleted or renamed extension models do not
 * linger until the worker restarts.
 */
export function unregisterModel(provider: string, modelId: string): void {
	modelRuntime.unregisterModel(provider, modelId);
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined || supportsXhigh(model);
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Backwards-compatible xhigh check for Stella code that has not migrated to
 * model-level thinkingLevelMap yet.
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.thinkingLevelMap?.xhigh !== undefined) return model.thinkingLevelMap.xhigh !== null;
	if (
		model.id.includes("gpt-5.2") ||
		model.id.includes("gpt-5.3") ||
		model.id.includes("gpt-5.4") ||
		model.id.includes("gpt-5.5") ||
		model.id.includes("gpt-5.6")
	)
		return true;
	if (model.api === "anthropic-messages") return model.id.includes("opus-4-6") || model.id.includes("opus-4.6");
	return false;
}
