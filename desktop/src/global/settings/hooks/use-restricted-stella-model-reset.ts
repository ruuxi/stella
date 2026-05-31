import { useEffect, useMemo, useRef } from "react";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { isRestrictedModelOverrideAudience } from "@/global/billing/audience";

const ASSISTANT_MODEL_KEYS = ["orchestrator", "general"] as const;

type LocalModelPreferences = {
  modelOverrides?: Record<string, string>;
  assistantPropagatedAgents?: string[];
};

const isStellaOverride = (modelId: string | undefined): modelId is string =>
  typeof modelId === "string" && modelId.startsWith("stella/");

/**
 * When a user signs out or drops to a restricted Stella audience, premium
 * Stella overrides become invalid. Clear just those assistant overrides so
 * the runtime and UI fall back to the backend-provided free/default model.
 */
export function useRestrictedStellaModelReset() {
  const { models, audience, loading } = useModelCatalog();
  const resetKeyRef = useRef<string | null>(null);

  const disallowedStellaModelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const model of models) {
      if (
        model.provider === "stella" &&
        model.allowedForAudience === false
      ) {
        ids.add(model.id);
        if (model.upstreamModel) ids.add(model.upstreamModel);
      }
    }
    return ids;
  }, [models]);

  useEffect(() => {
    if (!isRestrictedModelOverrideAudience(audience)) {
      resetKeyRef.current = null;
      return;
    }
    if (loading) return;

    const resetKey = `${audience}:${Array.from(disallowedStellaModelIds)
      .sort()
      .join("|")}`;
    if (resetKeyRef.current === resetKey) return;

    let cancelled = false;
    resetKeyRef.current = resetKey;

    const resetUnavailableOverrides = async () => {
      let preferences: LocalModelPreferences | null | undefined;
      try {
        preferences =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
      } catch {
        return;
      }
      if (cancelled) return;

      const currentOverrides = preferences?.modelOverrides ?? {};
      const nextOverrides = { ...currentOverrides };
      let changed = false;

      for (const key of ASSISTANT_MODEL_KEYS) {
        const override = currentOverrides[key];
        if (
          isStellaOverride(override) &&
          disallowedStellaModelIds.has(override)
        ) {
          delete nextOverrides[key];
          changed = true;
        }
      }

      if (!changed) return;

      try {
        await window.electronAPI?.system?.setLocalModelPreferences?.({
          modelOverrides: nextOverrides,
          assistantPropagatedAgents:
            preferences?.assistantPropagatedAgents ?? [],
        });
        if (!cancelled) {
          window.dispatchEvent(
            new CustomEvent("stella:local-model-preferences-changed"),
          );
        }
      } catch {
        resetKeyRef.current = null;
      }
    };

    void resetUnavailableOverrides();

    return () => {
      cancelled = true;
    };
  }, [audience, disallowedStellaModelIds, loading]);
}
