import type { LiveCodexModel } from "@/global/settings/lib/engine-model-routing";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

const ENGINE_MODEL_CATALOG_STALE_MS = 60 * 60 * 1000;
const CODEX_CATALOG_KEY = "default" as const;

const codexCatalogStore = createResourceStore<
  typeof CODEX_CATALOG_KEY,
  LiveCodexModel[]
>({
  staleMs: ENGINE_MODEL_CATALOG_STALE_MS,
  fetcher: async () => {
    const result = await window.electronAPI?.system?.listCodexModels?.();
    if (!result) throw new Error("Codex model discovery is unavailable.");
    return result.models.filter((model) => !model.hidden);
  },
});

export function useCodexModelCatalog(enabled = true) {
  const { data, error, isLoading, isFetching, refresh } = useResourceStore(
    codexCatalogStore,
    enabled ? CODEX_CATALOG_KEY : null,
  );

  return {
    models: data ?? null,
    loading: enabled && (isLoading || isFetching),
    error: error?.message ?? null,
    refresh,
  };
}
