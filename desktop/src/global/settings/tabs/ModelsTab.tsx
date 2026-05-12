import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import {
  findApiKey,
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";

const AgentModelPicker = lazy(() =>
  import("@/global/settings/AgentModelPicker").then((m) => ({
    default: m.AgentModelPicker,
  })),
);

function ModelConfigSection() {
  return (
    <div className="settings-card settings-card--models">
      <h3 className="settings-card-title">Models</h3>
      <p className="settings-card-desc">
        Pick a model for any agent and choose where image generation and
        realtime voice run. Bring your own key or sign in to another
        provider in the panel below — anything you connect lives on this
        device only.
      </p>
      <Suspense fallback={null}>
        <AgentModelPicker surface="settings" />
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
          No providers connected yet. Pick a non-Stella option in the model
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
    <div className="settings-tab-content settings-tab-content--models">
      <ModelConfigSection />
      <ConnectedProvidersSection />
    </div>
  );
}
