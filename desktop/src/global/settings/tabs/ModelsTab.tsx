import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import {
  findApiKey,
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";
import { getSettingsErrorMessage } from "./shared";

const AgentModelPicker = lazy(() =>
  import("@/global/settings/AgentModelPicker").then((m) => ({
    default: m.AgentModelPicker,
  })),
);

const GENERAL_AGENT_ENGINE_OPTIONS = [
  { id: "default", name: "Stella" },
  { id: "claude_code_local", name: "Claude Code" },
] as const;

const MAX_AGENT_CONCURRENCY_OPTIONS = Array.from(
  { length: 24 },
  (_, index) => index + 1,
);

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  reasoningEfforts: Record<
    string,
    "minimal" | "low" | "medium" | "high" | "xhigh"
  >;
  generalAgentEngine: "default" | "claude_code_local";
  selfModAgentEngine: "default" | "claude_code_local";
  maxAgentConcurrency: number;
};

function ModelConfigSection() {
  const [modelPreferences, setModelPreferences] =
    useState<LocalModelPreferences | null>(null);
  const [localGeneralAgentEngine, setLocalGeneralAgentEngine] = useState<
    "default" | "claude_code_local" | null
  >(null);
  const [localMaxAgentConcurrency, setLocalMaxAgentConcurrency] = useState<
    number | null
  >(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isSavingRuntimePreference, setIsSavingRuntimePreference] =
    useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadPreferences = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled) {
          setModelPreferences(next ?? null);
          setRuntimeError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeError(
            getSettingsErrorMessage(error, "Failed to load model settings."),
          );
        }
      }
    };

    void loadPreferences();
    return () => {
      cancelled = true;
    };
  }, []);

  const runtimePreferencesLoaded = modelPreferences !== null;

  const effectiveGeneralAgentEngine =
    (localGeneralAgentEngine !== null &&
    localGeneralAgentEngine !== modelPreferences?.generalAgentEngine
      ? localGeneralAgentEngine
      : null) ??
    modelPreferences?.generalAgentEngine ??
    "default";
  const effectiveMaxAgentConcurrency =
    (localMaxAgentConcurrency !== null &&
    localMaxAgentConcurrency !== modelPreferences?.maxAgentConcurrency
      ? localMaxAgentConcurrency
      : null) ??
    modelPreferences?.maxAgentConcurrency ??
    24;

  const handleAgentEngineChange = useCallback(
    async (_agentType: "general", value: string) => {
      if (isSavingRuntimePreference) {
        return;
      }

      const engine =
        value === "claude_code_local" ? "claude_code_local" : "default";
      const previousValue = localGeneralAgentEngine;

      setRuntimeError(null);
      setIsSavingRuntimePreference(true);
      setLocalGeneralAgentEngine(engine);

      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            generalAgentEngine: engine,
          });
        if (saved) {
          setModelPreferences(saved);
        }
      } catch (error) {
        setLocalGeneralAgentEngine(previousValue);
        setRuntimeError(
          getSettingsErrorMessage(
            error,
            "Failed to update the general agent runtime.",
          ),
        );
      } finally {
        setIsSavingRuntimePreference(false);
      }
    },
    [isSavingRuntimePreference, localGeneralAgentEngine],
  );

  const handleMaxAgentConcurrencyChange = useCallback(
    async (value: string) => {
      if (isSavingRuntimePreference) {
        return;
      }

      const parsed = Number(value);
      const normalized =
        Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 24;
      const previousValue = localMaxAgentConcurrency;

      setRuntimeError(null);
      setIsSavingRuntimePreference(true);
      setLocalMaxAgentConcurrency(normalized);

      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            maxAgentConcurrency: normalized,
          });
        if (saved) {
          setModelPreferences(saved);
        }
      } catch (error) {
        setLocalMaxAgentConcurrency(previousValue);
        setRuntimeError(
          getSettingsErrorMessage(
            error,
            "Failed to update max agent concurrency.",
          ),
        );
      } finally {
        setIsSavingRuntimePreference(false);
      }
    },
    [isSavingRuntimePreference, localMaxAgentConcurrency],
  );

  return (
    <>
      <div className="settings-card">
        <h3 className="settings-card-title">Agents</h3>
        <p className="settings-card-desc">
          Choose how Stella runs background tasks on your computer.
        </p>
        {runtimeError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {runtimeError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Engine</div>
            <div className="settings-row-sublabel">
              Powers Stella's main assistant. Choosing Claude Code requires the{" "}
              <code>claude</code> command installed on your computer.
            </div>
          </div>
          <div className="settings-row-control">
            {runtimePreferencesLoaded ? (
              <Select
                className="settings-runtime-select"
                value={effectiveGeneralAgentEngine}
                onValueChange={(value) =>
                  void handleAgentEngineChange("general", value)
                }
                disabled={isSavingRuntimePreference}
                aria-label="Engine"
                options={GENERAL_AGENT_ENGINE_OPTIONS.map((option) => ({
                  value: option.id,
                  label: option.name,
                }))}
              />
            ) : (
              <Select
                className="settings-runtime-select"
                value="loading"
                disabled
                aria-label="Engine"
                options={[
                  { value: "loading", label: "Loading saved setting..." },
                ]}
              />
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Max running tasks</div>
            <div className="settings-row-sublabel">
              How many background tasks Stella can run at the same time.
            </div>
          </div>
          <div className="settings-row-control">
            {runtimePreferencesLoaded ? (
              <Select
                className="settings-runtime-select"
                value={String(effectiveMaxAgentConcurrency)}
                onValueChange={(value) =>
                  void handleMaxAgentConcurrencyChange(value)
                }
                disabled={isSavingRuntimePreference}
                aria-label="Max running tasks"
                options={MAX_AGENT_CONCURRENCY_OPTIONS.map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
              />
            ) : (
              <Select
                className="settings-runtime-select"
                value="loading"
                disabled
                aria-label="Max running tasks"
                options={[
                  { value: "loading", label: "Loading saved setting..." },
                ]}
              />
            )}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <h3 className="settings-card-title">Models</h3>
        <p className="settings-card-desc">
          Pick which model and provider Stella uses for each kind of task. The
          toggle below switches between the two agents.
        </p>
        <Suspense fallback={null}>
          <AgentModelPicker />
        </Suspense>
      </div>
    </>
  );
}

/**
 * Read-only "Connected providers" view. Sign-in / API-key entry now happens
 * inline inside the model picker — this card just shows the user which
 * providers are currently authenticated and lets them disconnect.
 */
function ConnectedProvidersSection() {
  const credentials = useLlmCredentials();
  const [removingProvider, setRemovingProvider] = useState<string | null>(null);

  const connectedProviders = useMemo(() => {
    return LLM_PROVIDERS.map((entry) => {
      const apiKey = findApiKey(credentials.apiKeys, entry.key);
      const oauth = findOauthCredential(
        credentials.oauthCredentials,
        entry.key,
      );
      if (!apiKey && !oauth) return null;
      return { ...entry, apiKey, oauth };
    }).filter(Boolean) as Array<
      (typeof LLM_PROVIDERS)[number] & {
        apiKey: ReturnType<typeof findApiKey>;
        oauth: ReturnType<typeof findOauthCredential>;
      }
    >;
  }, [credentials.apiKeys, credentials.oauthCredentials]);

  const handleRemove = useCallback(
    async (providerKey: string, kind: "key" | "oauth") => {
      setRemovingProvider(providerKey);
      try {
        if (kind === "key") {
          await credentials.removeApiKey(providerKey);
        } else {
          await credentials.logoutOAuth(providerKey);
        }
      } catch {
        // surface failures via the credentials hook's own error state next reload
      } finally {
        setRemovingProvider(null);
      }
    },
    [credentials],
  );

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Connected providers</h3>
      <p className="settings-card-desc">
        Sign in to providers from the model picker. Anything you connect lives
        on this device only and shows up here so you can disconnect it.
      </p>
      {credentials.error ? (
        <p
          className="settings-card-desc settings-card-desc--error"
          role="alert"
        >
          {credentials.error}
        </p>
      ) : null}
      {connectedProviders.length === 0 ? (
        <p className="settings-card-desc">
          No providers connected yet. Pick a non-Stella model in any agent's
          picker above to add an API key or sign in.
        </p>
      ) : (
        connectedProviders.map((provider) => {
          const isRemoving = removingProvider === provider.key;
          return (
            <div key={provider.key} className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-label">{provider.label}</div>
                <div className="settings-row-sublabel">
                  {provider.apiKey ? (
                    <span className="settings-key-status">
                      <span className="settings-key-dot settings-key-dot--active" />
                      API key
                    </span>
                  ) : null}
                  {provider.oauth ? (
                    <span className="settings-key-status">
                      <span className="settings-key-dot settings-key-dot--active" />
                      Signed in
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="settings-row-control">
                {provider.apiKey ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn settings-btn--danger"
                    onClick={() => void handleRemove(provider.key, "key")}
                    disabled={isRemoving}
                  >
                    {isRemoving ? "Removing…" : "Remove key"}
                  </Button>
                ) : null}
                {provider.oauth ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn settings-btn--danger"
                    onClick={() => void handleRemove(provider.key, "oauth")}
                    disabled={isRemoving}
                  >
                    {isRemoving ? "Signing out…" : "Sign out"}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function ModelsTab() {
  return (
    <div className="settings-tab-content">
      <ModelConfigSection />
      <ConnectedProvidersSection />
    </div>
  );
}
