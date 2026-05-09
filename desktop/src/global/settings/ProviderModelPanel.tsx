import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, KeyRound, LogIn, Search } from "lucide-react";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { Select } from "@/ui/select";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  searchCatalogModels,
  type CatalogModel,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import {
  LLM_PROVIDERS,
  isApiKeyOnlyPlaceholder,
  type LlmProviderEntry,
} from "@/global/settings/lib/llm-providers";
import {
  findApiKey,
  findOauthCredential,
  findOauthProvider,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import "./ProviderModelPicker.css";

const STELLA_PROVIDER_KEY = "stella";
const LOCAL_PROVIDER_KEY = "local";
const DEFAULT_TARGET = "__default__";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

type ProviderTab = {
  key: string;
  label: string;
  models: CatalogModel[];
  llmEntry: LlmProviderEntry | undefined;
};

interface ProviderModelPanelProps {
  /** Currently selected model id. Empty string means default. */
  value: string;
  /** Label shown for the default option. */
  defaultLabel: string;
  /** Label for the currently active selection, whether default or override. */
  currentLabel: string;
  /** Reasoning effort shown only for direct non-Stella selections. */
  reasoningEffort: string;
  reasoningEffortOptions: Array<{ id: string; label: string }>;
  /** Provider-grouped catalog. */
  groups: ProviderGroup[];
  /** Hide a specific model id from the list (e.g. STELLA_DEFAULT_MODEL). */
  excludeModelId?: string;
  /** Empty string ⇒ default. Any other value ⇒ that model id. */
  onSelect: (value: string) => void;
  onReasoningEffortSelect: (value: string) => void;
  showReasoning?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

function buildProviderTabs(
  groups: readonly ProviderGroup[],
  excludeModelId: string | undefined,
): ProviderTab[] {
  const tabs = new Map<string, ProviderTab>();
  for (const group of groups) {
    const models = group.models.filter(
      (model) => !excludeModelId || model.id !== excludeModelId,
    );
    if (models.length === 0) continue;
    tabs.set(group.provider, {
      key: group.provider,
      label: group.providerName,
      models,
      llmEntry: LLM_PROVIDERS.find((entry) => entry.key === group.provider),
    });
  }
  return Array.from(tabs.values()).sort((a, b) => {
    if (a.key === STELLA_PROVIDER_KEY) return -1;
    if (b.key === STELLA_PROVIDER_KEY) return 1;
    if (a.key === LOCAL_PROVIDER_KEY) return -1;
    if (b.key === LOCAL_PROVIDER_KEY) return 1;
    return a.label.localeCompare(b.label);
  });
}

function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : STELLA_PROVIDER_KEY;
}

export function ProviderModelPanel({
  value,
  defaultLabel,
  currentLabel,
  reasoningEffort,
  reasoningEffortOptions,
  groups,
  excludeModelId,
  onSelect,
  onReasoningEffortSelect,
  showReasoning = true,
  disabled = false,
  ariaLabel,
}: ProviderModelPanelProps) {
  const credentials = useLlmCredentials();
  const tabs = useMemo(
    () => buildProviderTabs(groups, excludeModelId),
    [groups, excludeModelId],
  );

  const fallbackTab = tabs[0]?.key ?? STELLA_PROVIDER_KEY;
  const initialTab = useMemo(() => {
    if (!value) return fallbackTab;
    const provider = providerOf(value);
    return tabs.some((tab) => tab.key === provider) ? provider : fallbackTab;
  }, [fallbackTab, tabs, value]);

  const [activeProvider, setActiveProvider] = useState<string>(initialTab);
  const [query, setQuery] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [openRouterCustomId, setOpenRouterCustomId] = useState("");
  const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [localModelId, setLocalModelId] = useState("");

  // Whenever the externally-driven `value` switches to a different provider
  // (e.g. the user toggles agents in the parent), re-anchor the rail to that
  // model's provider so the right pane reflects the active selection.
  useEffect(() => {
    setActiveProvider(initialTab);
    setQuery("");
    setDraftKey("");
    setAuthError(null);
    setOpenRouterCustomId("");
    setLocalBaseUrl(DEFAULT_LOCAL_BASE_URL);
    setLocalModelId("");
  }, [initialTab]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeProvider) ?? tabs[0],
    [activeProvider, tabs],
  );
  const canEditReasoning =
    showReasoning &&
    Boolean(value) &&
    providerOf(value) !== STELLA_PROVIDER_KEY;

  const filteredModels = useMemo(() => {
    if (!activeTab) return [];
    const trimmed = query.trim();
    if (!trimmed) return activeTab.models;
    return searchCatalogModels(activeTab.models, trimmed);
  }, [activeTab, query]);

  const isProviderConnected = useCallback(
    (providerKey: string) => {
      if (providerKey === STELLA_PROVIDER_KEY) return true;
      if (findApiKey(credentials.apiKeys, providerKey)) return true;
      if (findOauthCredential(credentials.oauthCredentials, providerKey))
        return true;
      return false;
    },
    [credentials.apiKeys, credentials.oauthCredentials],
  );

  const handlePick = useCallback(
    (modelId: string) => {
      if (disabled) return;
      onSelect(modelId === DEFAULT_TARGET ? "" : modelId);
    },
    [disabled, onSelect],
  );

  const handleSaveKey = useCallback(
    async (providerKey: string, label: string) => {
      const trimmed = draftKey.trim();
      if (!trimmed) return;
      setSavingProvider(providerKey);
      setAuthError(null);
      try {
        await credentials.saveApiKey(providerKey, label, trimmed);
        setDraftKey("");
      } catch (caught) {
        setAuthError(
          caught instanceof Error ? caught.message : "Failed to save API key.",
        );
      } finally {
        setSavingProvider(null);
      }
    },
    [credentials, draftKey],
  );

  const handleLoginOAuth = useCallback(
    async (providerKey: string) => {
      setOauthProvider(providerKey);
      setAuthError(null);
      try {
        await credentials.loginOAuth(providerKey);
      } catch (caught) {
        setAuthError(
          caught instanceof Error ? caught.message : "OAuth login failed.",
        );
      } finally {
        setOauthProvider(null);
      }
    },
    [credentials],
  );

  const handleSubmitOpenRouter = useCallback(() => {
    const trimmed = openRouterCustomId.trim();
    if (!trimmed) return;
    const fullId = trimmed.startsWith("openrouter/")
      ? trimmed
      : `openrouter/${trimmed}`;
    onSelect(fullId);
  }, [onSelect, openRouterCustomId]);

  const handleSubmitLocal = useCallback(() => {
    const modelId = localModelId.trim();
    if (!modelId) return;
    const baseUrl = localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL;
    const encodedBaseUrl = encodeURIComponent(baseUrl);
    onSelect(
      modelId.startsWith(`${LOCAL_PROVIDER_KEY}/`)
        ? modelId
        : `${LOCAL_PROVIDER_KEY}/${encodedBaseUrl}/${modelId}`,
    );
  }, [localBaseUrl, localModelId, onSelect]);

  return (
    <div
      className="model-picker-shell"
      data-disabled={disabled || undefined}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="model-picker-current" aria-live="polite">
        <span className="model-picker-current-kicker">Selected</span>
        <span className="model-picker-current-label">{currentLabel}</span>
        {canEditReasoning ? (
          <div className="model-picker-current-reasoning">
            <span>Reasoning</span>
            <Select
              value={reasoningEffort}
              onValueChange={(value) => onReasoningEffortSelect(value)}
              disabled={disabled}
              aria-label="Reasoning effort"
              options={reasoningEffortOptions.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
            />
          </div>
        ) : null}
      </div>
      <aside className="model-picker-rail" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={!value}
          className="model-picker-rail-item model-picker-rail-item--default"
          data-selected={!value || undefined}
          onClick={() => handlePick(DEFAULT_TARGET)}
          disabled={disabled}
        >
          <span className="model-picker-rail-label">
            {value ? "Use Stella Recommended" : defaultLabel}
          </span>
        </button>
        <div className="model-picker-rail-divider" />
        {tabs.map((tab) => {
          const isActive = tab.key === activeProvider;
          const connected = isProviderConnected(tab.key);
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="model-picker-rail-item"
              data-active={isActive || undefined}
              onClick={() => {
                setActiveProvider(tab.key);
                setQuery("");
                setDraftKey("");
                setAuthError(null);
              }}
              disabled={disabled}
            >
              <span
                className="model-picker-rail-dot"
                data-on={connected || undefined}
                aria-hidden
              />
              <span className="model-picker-rail-label">{tab.label}</span>
            </button>
          );
        })}
      </aside>

      <section className="model-picker-pane" aria-live="polite">
        {activeTab ? (
          <ProviderPane
            tab={activeTab}
            query={query}
            onQueryChange={setQuery}
            selectedModelId={value}
            filteredModels={filteredModels}
            onPick={handlePick}
            isStella={activeTab.key === STELLA_PROVIDER_KEY}
            apiKey={findApiKey(credentials.apiKeys, activeTab.key)}
            oauthProvider={findOauthProvider(
              credentials.oauthProviders,
              activeTab.key,
            )}
            oauthCredential={findOauthCredential(
              credentials.oauthCredentials,
              activeTab.key,
            )}
            draftKey={draftKey}
            onDraftKeyChange={setDraftKey}
            onSaveKey={() =>
              activeTab.llmEntry
                ? handleSaveKey(activeTab.key, activeTab.label)
                : undefined
            }
            saving={savingProvider === activeTab.key}
            oauthInFlight={oauthProvider === activeTab.key}
            onLoginOAuth={() => handleLoginOAuth(activeTab.key)}
            authError={authError}
            openRouterCustomId={openRouterCustomId}
            onOpenRouterCustomIdChange={setOpenRouterCustomId}
            onSubmitOpenRouterCustomId={handleSubmitOpenRouter}
            localBaseUrl={localBaseUrl}
            onLocalBaseUrlChange={setLocalBaseUrl}
            localModelId={localModelId}
            onLocalModelIdChange={setLocalModelId}
            onSubmitLocalModelId={handleSubmitLocal}
            disabled={disabled}
          />
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane
// ---------------------------------------------------------------------------

interface ProviderPaneProps {
  tab: ProviderTab;
  query: string;
  onQueryChange: (next: string) => void;
  selectedModelId: string;
  filteredModels: CatalogModel[];
  onPick: (modelId: string) => void;
  isStella: boolean;
  apiKey: ReturnType<typeof findApiKey>;
  oauthProvider: ReturnType<typeof findOauthProvider>;
  oauthCredential: ReturnType<typeof findOauthCredential>;
  draftKey: string;
  onDraftKeyChange: (next: string) => void;
  onSaveKey: () => void;
  saving: boolean;
  oauthInFlight: boolean;
  onLoginOAuth: () => void;
  authError: string | null;
  openRouterCustomId: string;
  onOpenRouterCustomIdChange: (next: string) => void;
  onSubmitOpenRouterCustomId: () => void;
  localBaseUrl: string;
  onLocalBaseUrlChange: (next: string) => void;
  localModelId: string;
  onLocalModelIdChange: (next: string) => void;
  onSubmitLocalModelId: () => void;
  disabled: boolean;
}

function ProviderPane({
  tab,
  query,
  onQueryChange,
  selectedModelId,
  filteredModels,
  onPick,
  isStella,
  apiKey,
  oauthProvider,
  oauthCredential,
  draftKey,
  onDraftKeyChange,
  onSaveKey,
  saving,
  oauthInFlight,
  onLoginOAuth,
  authError,
  openRouterCustomId,
  onOpenRouterCustomIdChange,
  onSubmitOpenRouterCustomId,
  localBaseUrl,
  onLocalBaseUrlChange,
  localModelId,
  onLocalModelIdChange,
  onSubmitLocalModelId,
  disabled,
}: ProviderPaneProps) {
  const llmEntry =
    tab.llmEntry ??
    (!isStella
      ? {
          key: tab.key,
          label: tab.label,
          placeholder: "API key",
        }
      : undefined);
  const connected = isStella || Boolean(apiKey) || Boolean(oauthCredential);
  const isLocal = tab.key === LOCAL_PROVIDER_KEY;
  const requiresAuth = !isStella && !isLocal && !connected && Boolean(llmEntry);
  const supportsApiKey =
    Boolean(llmEntry) && !isApiKeyOnlyPlaceholder(llmEntry?.placeholder ?? "");
  const supportsOAuth = Boolean(oauthProvider);
  const isOpenRouter = tab.key === "openrouter";
  let authDescription: string;
  if (supportsOAuth && supportsApiKey) {
    authDescription = `Sign in to ${tab.label} or add an API key. Stella stores credentials on this device only.`;
  } else if (supportsOAuth) {
    authDescription = `Sign in to ${tab.label} to use this provider. Stella stores credentials on this device only.`;
  } else {
    authDescription = `Add a ${tab.label} API key to use this provider. Stella stores the key on this device only.`;
  }

  return (
    <div className="model-picker-pane-inner">
      <header className="model-picker-pane-header">
        <div className="model-picker-pane-title">{tab.label}</div>
        {isLocal ? (
          <span className="model-picker-pane-badge" data-tone="ok">
            Ready
          </span>
        ) : apiKey || oauthCredential ? (
          <span className="model-picker-pane-badge" data-tone="ok">
            {apiKey ? "API key connected" : "Signed in"}
          </span>
        ) : llmEntry ? (
          <span className="model-picker-pane-badge" data-tone="muted">
            Not connected
          </span>
        ) : null}
      </header>

      {requiresAuth ? (
        <div className="model-picker-auth">
          <p className="model-picker-pane-desc">{authDescription}</p>
          {supportsOAuth ? (
            <div className="model-picker-auth-row">
              <LogIn size={13} aria-hidden />
              <Button
                type="button"
                variant="ghost"
                onClick={onLoginOAuth}
                disabled={oauthInFlight || disabled}
              >
                {oauthInFlight ? "Opening…" : `Sign in with ${tab.label}`}
              </Button>
            </div>
          ) : null}
          {supportsApiKey ? (
            <div className="model-picker-auth-row">
              <KeyRound size={13} aria-hidden />
              <TextField
                label={`${tab.label} API key`}
                hideLabel
                type="password"
                placeholder={llmEntry?.placeholder ?? "API key"}
                value={draftKey}
                onChange={(e) => onDraftKeyChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveKey();
                }}
                autoFocus={!supportsOAuth}
                disabled={disabled}
              />
              <Button
                type="button"
                variant="primary"
                onClick={onSaveKey}
                disabled={!draftKey.trim() || saving || disabled}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
          {authError ? (
            <p className="model-picker-pane-error" role="alert">
              {authError}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {isLocal ? (
            <div className="model-picker-local">
              <p className="model-picker-pane-desc">
                Use any local OpenAI-compatible server. Ollama usually runs at
                the URL below.
              </p>
              <div className="model-picker-auth-row">
                <TextField
                  label="Local URL"
                  hideLabel
                  placeholder={DEFAULT_LOCAL_BASE_URL}
                  value={localBaseUrl}
                  onChange={(e) => onLocalBaseUrlChange(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="model-picker-auth-row">
                <TextField
                  label="Local model"
                  hideLabel
                  placeholder="llama3.2"
                  value={localModelId}
                  onChange={(e) => onLocalModelIdChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmitLocalModelId();
                  }}
                  disabled={disabled}
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={onSubmitLocalModelId}
                  disabled={!localModelId.trim() || disabled}
                >
                  Use model
                </Button>
              </div>
              <div className="model-picker-pane-divider">
                <span>or pick from the list</span>
              </div>
            </div>
          ) : null}

          {isOpenRouter ? (
            <div className="model-picker-openrouter">
              <div className="model-picker-pane-desc">
                OpenRouter accepts any <code>vendor/model</code> id. Type one to
                use it directly.
              </div>
              <div className="model-picker-auth-row">
                <TextField
                  label="OpenRouter model id"
                  hideLabel
                  placeholder="anthropic/claude-opus-4.7"
                  value={openRouterCustomId}
                  onChange={(e) => onOpenRouterCustomIdChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmitOpenRouterCustomId();
                  }}
                  disabled={disabled}
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={onSubmitOpenRouterCustomId}
                  disabled={!openRouterCustomId.trim() || disabled}
                >
                  Use model
                </Button>
              </div>
              <div className="model-picker-pane-divider">
                <span>or pick from the list</span>
              </div>
            </div>
          ) : null}

          <div className="model-picker-search">
            <Search size={13} strokeWidth={1.75} aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={`Search ${tab.label}…`}
              spellCheck={false}
              autoComplete="off"
              aria-label={`Search ${tab.label} models`}
              disabled={disabled}
            />
          </div>
          <div className="model-picker-models" role="listbox">
            {filteredModels.length === 0 ? (
              <div className="model-picker-empty">
                {tab.models.length === 0
                  ? `No ${tab.label} models available yet.`
                  : "No models match."}
              </div>
            ) : (
              filteredModels.map((model) => {
                const selected = model.id === selectedModelId;
                const isStellaModel = model.provider === "stella";
                const displayName = isStellaModel
                  ? getStellaDisplayName(model)
                  : model.name;
                const subtitle = isStellaModel
                  ? getStellaSubtitle(model)
                  : model.upstreamModel && model.upstreamModel !== model.name
                    ? model.upstreamModel
                    : model.id !== model.name
                      ? model.id
                      : null;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="model-picker-model"
                    data-selected={selected || undefined}
                    onClick={() => onPick(model.id)}
                    disabled={disabled}
                  >
                    <span className="model-picker-model-text">
                      <span className="model-picker-model-name">
                        {displayName}
                      </span>
                      {subtitle ? (
                        <span className="model-picker-model-sub">
                          {subtitle}
                        </span>
                      ) : null}
                    </span>
                    {selected ? (
                      <Check size={13} className="model-picker-model-check" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}

      {!requiresAuth && llmEntry ? (
        <footer className="model-picker-pane-footer">
          {apiKey || oauthCredential ? (
            <span className="model-picker-pane-foot-text">
              {apiKey
                ? "Using your saved API key"
                : `Signed in as ${oauthCredential?.label ?? tab.label}`}
            </span>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}
