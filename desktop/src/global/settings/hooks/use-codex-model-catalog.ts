import { useCallback, useEffect, useState } from "react";
import type { LiveCodexModel } from "@/global/settings/lib/engine-model-routing";

export function useCodexModelCatalog() {
  const [models, setModels] = useState<LiveCodexModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.system?.listCodexModels?.();
      if (!result) throw new Error("Codex model discovery is unavailable.");
      setModels(result.models.filter((model) => !model.hidden));
    } catch (caught) {
      setModels(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "ChatGPT models could not be verified.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { models, loading, error, refresh };
}
