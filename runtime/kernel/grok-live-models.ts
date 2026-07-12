/**
 * Live model discovery for the grok CLI-proxy provider.
 *
 * The static registry ships a single hand-maintained grok entry (Composer),
 * but the proxy exposes its real, current model list at `GET /v1/models`
 * (e.g. Grok 4.5). Like the models.dev merge this is best-effort and purely
 * ADDITIVE: new ids are cloned from the built-in template so transport
 * details (API shape, compat flags, proxy base URL) stay correct, with the
 * per-model `x-grok-model-override` routing header rewritten to the new id.
 *
 * Requires a grok login session (`~/.grok/auth.json`); without one the
 * fetch is skipped entirely.
 */
import { getModels, registerModel } from "../ai/models.js";
import type { Api, Model } from "../ai/types.js";
import { readGrokCliSessionToken } from "./model-routing.js";

const GROK_PROVIDER = "grok";
const GROK_MODELS_TIMEOUT_MS = 3_000;
const GROK_MODEL_OVERRIDE_HEADER = "x-grok-model-override";

export type GrokLiveModel = {
  id?: string;
  name?: string;
  context_window?: number;
  supports_reasoning_effort?: boolean;
};

const getGrokTemplate = (): Model<Api> | undefined =>
  (getModels(GROK_PROVIDER as never) as Model<Api>[])[0];

export function registerGrokLiveModels(
  models: readonly GrokLiveModel[],
): number {
  const registryModels = getModels(GROK_PROVIDER as never) as Model<Api>[];
  const template = registryModels[0];
  if (!template) return 0;
  const existing = new Set(registryModels.map((model) => model.id));
  let registered = 0;
  for (const entry of models) {
    const modelId = entry.id?.trim();
    if (!modelId || existing.has(modelId)) continue;
    registerModel(GROK_PROVIDER, {
      ...template,
      id: modelId,
      name: entry.name?.trim() || modelId,
      reasoning: entry.supports_reasoning_effort ?? template.reasoning,
      contextWindow: entry.context_window ?? template.contextWindow,
      headers: {
        ...template.headers,
        [GROK_MODEL_OVERRIDE_HEADER]: modelId,
      },
    });
    existing.add(modelId);
    registered += 1;
  }
  return registered;
}

export async function fetchAndRegisterGrokLiveModels(): Promise<number> {
  const token = readGrokCliSessionToken();
  if (!token) return 0;
  const template = getGrokTemplate();
  if (!template) return 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROK_MODELS_TIMEOUT_MS);
  try {
    // The template's headers carry the proxy's client identification; the
    // model-override header is per-request routing and doesn't belong on a
    // list call.
    const { [GROK_MODEL_OVERRIDE_HEADER]: _omitted, ...listHeaders } =
      template.headers ?? {};
    const response = await fetch(`${template.baseUrl}/models`, {
      headers: { ...listHeaders, Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`grok /models returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as { data?: GrokLiveModel[] };
    return registerGrokLiveModels(data.data ?? []);
  } finally {
    clearTimeout(timeout);
  }
}
