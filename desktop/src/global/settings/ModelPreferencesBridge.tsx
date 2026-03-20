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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseModelOverrides(
  overridesJson: string | undefined,
  defaultModels: Record<string, string>,
) {
  if (!overridesJson) {
    return {};
  }

  const parsed = JSON.parse(overridesJson);
  assert(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    "Model overrides must be an object",
  );
  return normalizeModelOverrides(parsed as Record<string, string>, defaultModels);
}

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
  ) as "default" | "claude_code_local" | undefined;
  const selfModAgentEngine = useQuery(
    api.data.preferences.getSelfModAgentEngine,
    shouldQueryPreferences,
  ) as "default" | "claude_code_local" | undefined;
  const maxAgentConcurrency = useQuery(
    api.data.preferences.getMaxAgentConcurrency,
    shouldQueryPreferences,
  ) as number | undefined;

  const defaultModels = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModels = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );

  const modelOverrides = useMemo(
    () => parseModelOverrides(overridesJson, defaultModels),
    [defaultModels, overridesJson],
  );

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.syncLocalModelPreferences || !hasConnectedAccount) return;
    if (
      modelDefaults === undefined ||
      overridesJson === undefined ||
      generalAgentEngine === undefined ||
      selfModAgentEngine === undefined ||
      maxAgentConcurrency === undefined
    ) {
      return;
    }

    void systemApi.syncLocalModelPreferences({
      defaultModels,
      resolvedDefaultModels,
      modelOverrides,
      generalAgentEngine,
      selfModAgentEngine,
      maxAgentConcurrency,
    });
  }, [
    defaultModels,
    generalAgentEngine,
    hasConnectedAccount,
    maxAgentConcurrency,
    modelDefaults,
    modelOverrides,
    overridesJson,
    resolvedDefaultModels,
    selfModAgentEngine,
  ]);

  return null;
};

