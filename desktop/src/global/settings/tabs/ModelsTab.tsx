import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import {
  findApiKey,
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { getStellaDisplayName } from "@/global/settings/lib/model-catalog";
import {
  getConfigurableAgents,
  getLocalModelDefaults,
} from "@/global/settings/lib/model-defaults";
import { getSettingsErrorMessage } from "./shared";

const AgentModelPicker = lazy(() =>
  import("@/global/settings/AgentModelPicker").then((m) => ({
    default: m.AgentModelPicker,
  })),
);

function ModelConfigSection() {
  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Models</h3>
      <p className="settings-card-desc">
        Pick which Stella model each agent uses. Open “More options” for the
        full provider catalog and local runtime settings.
      </p>
      <Suspense fallback={null}>
        <AgentModelPicker />
      </Suspense>
    </div>
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

function BulkAgentModelSection() {
  const { stellaModels, defaults: serverDefaults } = useModelCatalog();
  const [bulkModel, setBulkModel] = useState<string>("");
  const [busy, setBusy] = useState<"apply" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const stellaOptions = useMemo(
    () =>
      stellaModels
        .filter((model) => model.provider === "stella")
        .map((model) => ({
          value: model.id,
          label: getStellaDisplayName(model),
        })),
    [stellaModels],
  );

  useEffect(() => {
    if (!bulkModel && stellaOptions.length > 0) {
      setBulkModel(stellaOptions[0].value);
    }
  }, [bulkModel, stellaOptions]);

  const configurableAgents = useMemo(() => {
    const defaults = getLocalModelDefaults(undefined, serverDefaults);
    return getConfigurableAgents(defaults);
  }, [serverDefaults]);

  const ready = stellaOptions.length > 0 && configurableAgents.length > 0;

  const handleApplyToAll = useCallback(async () => {
    if (!ready || !bulkModel || busy) return;
    setBusy("apply");
    setError(null);
    setFeedback(null);
    try {
      const overrides: Record<string, string> = {};
      for (const agent of configurableAgents) {
        overrides[agent.key] = bulkModel;
      }
      await window.electronAPI?.system?.setLocalModelPreferences?.({
        modelOverrides: overrides,
      });
      window.dispatchEvent(
        new CustomEvent("stella:local-model-preferences-changed"),
      );
      const label =
        stellaOptions.find((option) => option.value === bulkModel)?.label ??
        bulkModel;
      setFeedback(`Applied ${label} to ${configurableAgents.length} agents.`);
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, "Failed to apply model to all agents."),
      );
    } finally {
      setBusy(null);
    }
  }, [bulkModel, busy, configurableAgents, ready, stellaOptions]);

  const handleRestoreDefaults = useCallback(async () => {
    if (busy) return;
    setBusy("restore");
    setError(null);
    setFeedback(null);
    try {
      await window.electronAPI?.system?.setLocalModelPreferences?.({
        modelOverrides: {},
      });
      window.dispatchEvent(
        new CustomEvent("stella:local-model-preferences-changed"),
      );
      setFeedback("Restored model defaults for every agent.");
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, "Failed to restore model defaults."),
      );
    } finally {
      setBusy(null);
    }
  }, [busy]);

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Bulk actions</h3>
      <p className="settings-card-desc">
        Apply one Stella model to every agent, or restore Stella's defaults.
      </p>
      {error ? (
        <p
          className="settings-card-desc settings-card-desc--error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {feedback ? (
        <p className="settings-card-desc" role="status">
          {feedback}
        </p>
      ) : null}
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Apply to all agents</div>
          <div className="settings-row-sublabel">
            Picks the same Stella model for every agent.
          </div>
        </div>
        <div className="settings-row-control settings-row-control--inline">
          <Select
            value={bulkModel}
            onValueChange={setBulkModel}
            disabled={!ready || busy !== null}
            options={stellaOptions}
            aria-label="Bulk model"
            placeholder="Stella model"
          />
          <Button
            type="button"
            variant="secondary"
            className="settings-btn"
            onClick={() => void handleApplyToAll()}
            disabled={!ready || !bulkModel || busy !== null}
          >
            {busy === "apply" ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Restore defaults</div>
          <div className="settings-row-sublabel">
            Clears every per-agent model override.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn settings-btn--danger"
            onClick={() => void handleRestoreDefaults()}
            disabled={busy !== null}
          >
            {busy === "restore" ? "Restoring…" : "Restore"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ModelsTab() {
  return (
    <div className="settings-tab-content">
      <ModelConfigSection />
      <BulkAgentModelSection />
      <ConnectedProvidersSection />
    </div>
  );
}
