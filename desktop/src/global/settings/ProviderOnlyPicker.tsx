import { useCallback, useState } from "react";
import { Check, KeyRound, LogIn } from "lucide-react";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import {
  findApiKey,
  findOauthCredential,
  findOauthProvider,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import {
  LLM_PROVIDERS,
  isApiKeyOnlyPlaceholder,
} from "@/global/settings/lib/llm-providers";
import "./ProviderOnlyPicker.css";

export interface ProviderOption {
  /** Provider key (matches credential provider keys; `stella` for default). */
  key: string;
  /** User-visible label. */
  label: string;
  /** Optional short tagline rendered under the label. */
  description?: string;
}

interface ProviderOnlyPickerProps {
  /** Providers to render. The first entry is treated as the default / Stella option. */
  providers: readonly ProviderOption[];
  /** Currently selected provider key. */
  value: string;
  /** Called when the user picks a (connected) provider. */
  onSelect: (providerKey: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

const STELLA_PROVIDER_KEY = "stella";

/**
 * Flat, provider-first picker used for image and voice settings. Unlike the
 * full provider/model panel, every option is "the provider itself" — the
 * runtime picks the model. If the user taps a non-Stella provider they are
 * not connected to, the row expands inline with the OAuth / API-key flow
 * and we auto-select once credentials land.
 */
export function ProviderOnlyPicker({
  providers,
  value,
  onSelect,
  disabled = false,
  ariaLabel,
}: ProviderOnlyPickerProps) {
  const credentials = useLlmCredentials();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [oauthInFlight, setOauthInFlight] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const isConnected = useCallback(
    (key: string) => {
      if (key === STELLA_PROVIDER_KEY) return true;
      if (findApiKey(credentials.apiKeys, key)) return true;
      if (findOauthCredential(credentials.oauthCredentials, key)) return true;
      return false;
    },
    [credentials.apiKeys, credentials.oauthCredentials],
  );

  const handleRowClick = useCallback(
    (key: string) => {
      if (disabled) return;
      if (isConnected(key)) {
        setExpandedProvider(null);
        setAuthError(null);
        onSelect(key);
        return;
      }
      setExpandedProvider((current) => (current === key ? null : key));
      setDraftKey("");
      setAuthError(null);
    },
    [disabled, isConnected, onSelect],
  );

  const handleSaveKey = useCallback(
    async (key: string, label: string) => {
      const trimmed = draftKey.trim();
      if (!trimmed) return;
      setSavingProvider(key);
      setAuthError(null);
      try {
        await credentials.saveApiKey(key, label, trimmed);
        setDraftKey("");
        setExpandedProvider(null);
        onSelect(key);
      } catch (caught) {
        setAuthError(
          caught instanceof Error ? caught.message : "Failed to save API key.",
        );
      } finally {
        setSavingProvider(null);
      }
    },
    [credentials, draftKey, onSelect],
  );

  const handleLoginOAuth = useCallback(
    async (key: string) => {
      setOauthInFlight(key);
      setAuthError(null);
      try {
        await credentials.loginOAuth(key);
        setExpandedProvider(null);
        onSelect(key);
      } catch (caught) {
        setAuthError(
          caught instanceof Error ? caught.message : "OAuth login failed.",
        );
      } finally {
        setOauthInFlight(null);
      }
    },
    [credentials, onSelect],
  );

  return (
    <div
      className="provider-only-picker"
      role="radiogroup"
      aria-label={ariaLabel}
      data-disabled={disabled || undefined}
    >
      {providers.map((provider) => {
        const llmEntry = LLM_PROVIDERS.find(
          (entry) => entry.key === provider.key,
        );
        const oauthProvider = findOauthProvider(
          credentials.oauthProviders,
          provider.key,
        );
        const connected = isConnected(provider.key);
        const selected = value === provider.key;
        const expanded = expandedProvider === provider.key && !connected;
        const supportsOAuth = Boolean(oauthProvider);
        const supportsApiKey =
          Boolean(llmEntry) &&
          !isApiKeyOnlyPlaceholder(llmEntry?.placeholder ?? "");

        return (
          <div
            key={provider.key}
            className="provider-only-row"
            data-selected={selected || undefined}
            data-expanded={expanded || undefined}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              className="provider-only-row-main"
              onClick={() => handleRowClick(provider.key)}
              disabled={disabled}
            >
              <span className="provider-only-row-text">
                <span className="provider-only-row-name">{provider.label}</span>
                {provider.description ? (
                  <span className="provider-only-row-desc">
                    {provider.description}
                  </span>
                ) : null}
              </span>
              <span className="provider-only-row-meta">
                {provider.key !== STELLA_PROVIDER_KEY ? (
                  <span
                    className="provider-only-row-status"
                    data-on={connected || undefined}
                  >
                    {connected ? "Connected" : "Connect"}
                  </span>
                ) : null}
                {selected ? (
                  <Check size={13} className="provider-only-row-check" />
                ) : null}
              </span>
            </button>
            {expanded ? (
              <div className="provider-only-row-auth">
                {supportsOAuth ? (
                  <div className="provider-only-row-auth-line">
                    <LogIn size={13} aria-hidden />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void handleLoginOAuth(provider.key)}
                      disabled={oauthInFlight !== null || disabled}
                    >
                      {oauthInFlight === provider.key
                        ? "Opening…"
                        : `Sign in with ${provider.label}`}
                    </Button>
                  </div>
                ) : null}
                {supportsApiKey ? (
                  <div className="provider-only-row-auth-line">
                    <KeyRound size={13} aria-hidden />
                    <TextField
                      label={`${provider.label} API key`}
                      hideLabel
                      type="password"
                      placeholder={llmEntry?.placeholder ?? "API key"}
                      value={draftKey}
                      onChange={(event) => setDraftKey(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void handleSaveKey(provider.key, provider.label);
                        }
                      }}
                      autoFocus={!supportsOAuth}
                      disabled={disabled}
                    />
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() =>
                        void handleSaveKey(provider.key, provider.label)
                      }
                      disabled={
                        !draftKey.trim() ||
                        savingProvider === provider.key ||
                        disabled
                      }
                    >
                      {savingProvider === provider.key ? "Saving…" : "Save"}
                    </Button>
                  </div>
                ) : null}
                {authError ? (
                  <p className="provider-only-row-auth-error" role="alert">
                    {authError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
