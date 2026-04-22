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
  overrides: Record<string, string> | undefined,
  defaultModels: Record<string, string>,
) {
  if (!overrides) {
    return {};
  }
  assert(
    overrides !== null && typeof overrides === "object" && !Array.isArray(overrides),
    "Model overrides must be an object",
  );
  return normalizeModelOverrides(overrides, defaultModels);
}

export const ModelPreferencesBridge = () => {
  const { hasConnectedAccount } = useAuthSessionState();
  const shouldQueryPreferences = hasConnectedAccount ? {} : "skip";
  const serverOverrides = useQuery(
    api.data.preferences.getModelOverrides,
    shouldQueryPreferences,
  ) as Record<string, string> | undefined;
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
    () => parseModelOverrides(serverOverrides, defaultModels),
    [defaultModels, serverOverrides],
  );

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.syncLocalModelPreferences || !hasConnectedAccount) return;
    if (
      modelDefaults === undefined ||
      serverOverrides === undefined ||
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
    serverOverrides,
    resolvedDefaultModels,
    selfModAgentEngine,
  ]);

  return null;
};

