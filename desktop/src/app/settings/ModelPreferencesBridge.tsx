import { useEffect, useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  buildModelDefaultsMap,
  normalizeModelOverrides,
  type ModelDefaultEntry,
} from "@/app/settings/lib/model-defaults";

export const ModelPreferencesBridge = () => {
  const { isAuthenticated } = useConvexAuth();
  const shouldQueryPreferences = isAuthenticated ? {} : "skip";
  const overridesJson = useQuery(
    api.data.preferences.getModelOverrides,
    shouldQueryPreferences,
  ) as string | undefined;
  const modelDefaults = useQuery(
    api.data.preferences.getModelDefaults,
    shouldQueryPreferences,
  ) as ModelDefaultEntry[] | undefined;
  const generalAgentEngine = useQuery(
    api.data.preferences.getGeneralAgentEngine,
    shouldQueryPreferences,
  ) as
    | "default"
    | "codex_local"
    | "claude_code_local"
    | undefined;
  const codexLocalMaxConcurrency = useQuery(
    api.data.preferences.getCodexLocalMaxConcurrency,
    shouldQueryPreferences,
  ) as
    | number
    | undefined;
  const preferencesLoaded =
    !isAuthenticated
    || (
      modelDefaults !== undefined
      && overridesJson !== undefined
      && generalAgentEngine !== undefined
      && codexLocalMaxConcurrency !== undefined
    );

  const defaultModels = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );

  const modelOverrides = useMemo<Record<string, string>>(() => {
    if (!overridesJson) {
      return {};
    }

    try {
      return normalizeModelOverrides(
        JSON.parse(overridesJson) as Record<string, string>,
        defaultModels,
      );
    } catch {
      return {};
    }
  }, [defaultModels, overridesJson]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.syncLocalModelPreferences) {
      return;
    }
    if (!isAuthenticated) {
      return;
    }
    if (!preferencesLoaded) {
      return;
    }

    void systemApi.syncLocalModelPreferences({
      defaultModels,
      modelOverrides,
      generalAgentEngine: generalAgentEngine ?? "default",
      codexLocalMaxConcurrency: codexLocalMaxConcurrency ?? 3,
    });
  }, [
    codexLocalMaxConcurrency,
    defaultModels,
    generalAgentEngine,
    isAuthenticated,
    modelOverrides,
    preferencesLoaded,
  ]);

  return null;
};
