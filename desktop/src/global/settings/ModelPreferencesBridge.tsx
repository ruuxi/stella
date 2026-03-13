import { useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  normalizeModelOverrides,
  type ModelDefaultEntry,
} from "@/global/settings/lib/model-defaults";

export const ModelPreferencesBridge = () => {
  const { hasConnectedAccount } = useAuthSessionState();
  const shouldQueryPreferences = hasConnectedAccount ? {} : "skip";
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
  const selfModAgentEngine = useQuery(
    api.data.preferences.getSelfModAgentEngine,
    shouldQueryPreferences,
  ) as
    | "default"
    | "codex_local"
    | "claude_code_local"
    | undefined;
  const maxAgentConcurrency = useQuery(
    api.data.preferences.getMaxAgentConcurrency,
    shouldQueryPreferences,
  ) as
    | number
    | undefined;
  const preferencesLoaded =
    !hasConnectedAccount
    || (
      modelDefaults !== undefined
      && overridesJson !== undefined
      && generalAgentEngine !== undefined
      && selfModAgentEngine !== undefined
      && maxAgentConcurrency !== undefined
    );

  const defaultModels = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModels = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
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
    if (!hasConnectedAccount) {
      return;
    }
    if (!preferencesLoaded) {
      return;
    }

    void systemApi.syncLocalModelPreferences({
      defaultModels,
      resolvedDefaultModels,
      modelOverrides,
      generalAgentEngine: generalAgentEngine ?? "default",
      selfModAgentEngine: selfModAgentEngine ?? "default",
      maxAgentConcurrency: maxAgentConcurrency ?? 24,
    });
  }, [
    defaultModels,
    generalAgentEngine,
    hasConnectedAccount,
    maxAgentConcurrency,
    modelOverrides,
    preferencesLoaded,
    resolvedDefaultModels,
    selfModAgentEngine,
  ]);

  return null;
};

