import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  Check,
  KeyRound,
  Lightbulb,
  LogIn,
  LogOut,
  Search,
  Star,
} from "@/ui/icons";
import { BrandIcon } from "@/ui/brand-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  readEngineModelFavorites,
  sortByFavorites,
  toggleEngineModelFavorite,
} from "@/features/workspace-display/engine-model-favorites";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  searchCatalogModels,
  type CatalogModel,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import {
  compareProviderRailOrder,
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

export type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const REASONING_OPTIONS: ReadonlyArray<{ id: ReasoningEffort; label: string }> =
  [
    { id: "default", label: "Auto" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Max" },
  ];

const STELLA_PROVIDER_KEY = "stella";
const LOCAL_PROVIDER_KEY = "local";
const GROK_PROVIDER_KEY = "grok";
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
  /** Provider-grouped catalog. */
  groups: ProviderGroup[];
  /** Empty string ⇒ default. Any other value ⇒ that model id. */
  onSelect: (value: string, anchor?: HTMLElement) => void;
  disabled?: boolean;
  /** When set, only these provider keys appear in the list. */
  visibleProviders?: readonly string[];
  /** When set, enables per-model favorites pinned to the top of each section. */
  favoriteScope?: string;
  /**
   * Current reasoning effort applied to the agent set. When
   * `onSelectReasoning` is also provided, each model row shows a hover
   * lightbulb that opens a reasoning-level menu.
   */
  reasoningEffort?: ReasoningEffort;
  /** Apply a model at a specific reasoning effort. */
  onSelectReasoning?: (modelId: string, effort: ReasoningEffort) => void;
  /**
   * When true, the user's plan can't override the default Stella model
   * (anonymous / free / Go). Non-default rows in the Stella section are
   * disabled; BYOK providers stay fully interactive.
   */
  restrictStellaPicks?: boolean;
  restrictedPlanLabel?: string | null;
  ariaLabel?: string;
  /**
   * When true, the leading "Default …" row in the Stella section is
   * suppressed. Used by the global Models settings page, where the
   * picker has no single-agent context so "default" doesn't apply.
   */
  hideDefaultRow?: boolean;
  /**
   * When set, replaces the "Selected …" header kicker. The Models
   * settings page uses this to swap the affordance from "currently
   * selected" to "click a model to assign".
   */
  selectedHeaderKicker?: string;
  /** When true, the "Selected …" title is hidden. */
  hideSelectedTitle?: boolean;
  /** When true, selected model rows omit the trailing checkmark. */
  hideSelectionCheck?: boolean;
  /** When true, only the Stella provider can be picked; other provider sections stay visible but disabled. */
  disableNonStellaProviders?: boolean;
  disabledProviderReason?: string;
  /**
   * Hide the provider icon + name in the section head. Used when the
   * embedder already names the provider (the sidebar picker's brand rail);
   * the connect / sign-out affordances stay.
   */
  hideProviderLabel?: boolean;
}

function buildProviderTabs(
  groups: readonly ProviderGroup[],
  visibleProviders: readonly string[] | undefined,
): ProviderTab[] {
  const tabs = new Map<string, ProviderTab>();
  for (const group of groups) {
    if (visibleProviders && !visibleProviders.includes(group.provider)) {
      continue;
    }
    const models = group.models;
    if (models.length === 0) continue;
    tabs.set(group.provider, {
      key: group.provider,
      label: group.providerName,
      models,
      llmEntry: LLM_PROVIDERS.find((entry) => entry.key === group.provider),
    });
  }
  return Array.from(tabs.values()).sort((a, b) =>
    compareProviderRailOrder(a.key, b.key, a.label, b.label),
  );
}

export function ProviderModelPanel({
  value,
  defaultLabel,
  currentLabel,
  groups,
  onSelect,
  disabled = false,
  reasoningEffort,
  onSelectReasoning,
  restrictStellaPicks = false,
  restrictedPlanLabel,
  ariaLabel,
  hideDefaultRow = false,
  selectedHeaderKicker,
  hideSelectedTitle = false,
  hideSelectionCheck = false,
  disableNonStellaProviders = false,
  disabledProviderReason,
  hideProviderLabel = false,
  visibleProviders,
  favoriteScope,
}: ProviderModelPanelProps) {
  const credentials = useLlmCredentials();
  const tabs = useMemo(
    () => buildProviderTabs(groups, visibleProviders),
    [groups, visibleProviders],
  );
  const [favorites, setFavorites] = useState<string[]>(() =>
    favoriteScope ? readEngineModelFavorites(favoriteScope) : [],
  );

  const disabledProviderSet = useMemo(
    () =>
      new Set(
        disableNonStellaProviders
          ? tabs
              .map((tab) => tab.key)
              .filter((key) => key !== STELLA_PROVIDER_KEY)
          : [],
      ),
    [disableNonStellaProviders, tabs],
  );

  const [query, setQuery] = useState("");
  // Which provider's inline form (connect / API key, or the local /
  // OpenRouter custom-model inputs) is expanded. Only one is open at a time
  // so the shared draft/api-key state stays unambiguous, and nothing opens
  // by default — sections collapse to just their model list.
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [openRouterCustomId, setOpenRouterCustomId] = useState("");
  const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [localModelId, setLocalModelId] = useState("");

  const sections = useMemo(() => {
    const trimmed = query.trim();
    const result: Array<{ tab: ProviderTab; models: CatalogModel[] }> = [];
    for (const tab of tabs) {
      const searched = trimmed
        ? searchCatalogModels(tab.models, trimmed)
        : tab.models;
      const sorted = favoriteScope
        ? sortByFavorites(searched, favorites)
        : searched;
      // Hide sections with no matching models while searching so the list
      // narrows to relevant providers instead of leaving empty headers.
      if (trimmed && sorted.length === 0) continue;
      result.push({ tab, models: sorted });
    }
    return result;
  }, [tabs, favoriteScope, favorites, query]);

  const toggleFavorite = useCallback(
    (modelId: string) => {
      if (!favoriteScope) return;
      setFavorites(toggleEngineModelFavorite(favoriteScope, modelId));
    },
    [favoriteScope],
  );

  const handlePick = useCallback(
    (modelId: string, anchor?: HTMLElement) => {
      if (disabled) return;
      onSelect(modelId === DEFAULT_TARGET ? "" : modelId, anchor);
    },
    [disabled, onSelect],
  );

  const toggleExpanded = useCallback((providerKey: string | null) => {
    setExpandedProvider(providerKey);
    setDraftKey("");
    setAuthError(null);
  }, []);

  // Sign-out: a connected provider shows a hover log-out icon in its section
  // header. First click arms it (visual confirm), a second click within the
  // window actually drops the API key + OAuth session for that provider.
  const [signOutArmed, setSignOutArmed] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const signOutTimerRef = useRef<number | null>(null);

  const handleSignOut = useCallback(
    async (providerKey: string) => {
      if (signOutArmed !== providerKey) {
        setSignOutArmed(providerKey);
        if (signOutTimerRef.current) {
          window.clearTimeout(signOutTimerRef.current);
        }
        signOutTimerRef.current = window.setTimeout(
          () => setSignOutArmed(null),
          3000,
        );
        return;
      }
      if (signOutTimerRef.current) {
        window.clearTimeout(signOutTimerRef.current);
        signOutTimerRef.current = null;
      }
      setSignOutArmed(null);
      setSigningOut(providerKey);
      try {
        if (findApiKey(credentials.apiKeys, providerKey)) {
          await credentials.removeApiKey(providerKey);
        }
        if (findOauthCredential(credentials.oauthCredentials, providerKey)) {
          await credentials.logoutOAuth(providerKey);
        }
      } catch {
        // Failures surface via the credentials hook's `error` state.
      } finally {
        setSigningOut(null);
      }
    },
    [credentials, signOutArmed],
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
        setExpandedProvider(null);
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
        setExpandedProvider(null);
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

  const trimmedQuery = query.trim();
  const isDefaultSelected = !value;

  const renderSection = (tab: ProviderTab, models: CatalogModel[]) => {
    const isStella = tab.key === STELLA_PROVIDER_KEY;
    const isLocal = tab.key === LOCAL_PROVIDER_KEY;
    const isGrok = tab.key === GROK_PROVIDER_KEY;
    const isOpenRouter = tab.key === "openrouter";
    const apiKey = findApiKey(credentials.apiKeys, tab.key);
    const oauthCred = findOauthCredential(
      credentials.oauthCredentials,
      tab.key,
    );
    const oauthEntry = findOauthProvider(credentials.oauthProviders, tab.key);
    const llmEntry =
      tab.llmEntry ??
      (!isStella
        ? { key: tab.key, label: tab.label, placeholder: "API key" }
        : undefined);
    const connected = isStella || Boolean(apiKey) || Boolean(oauthCred);
    const usesExternalLogin = isGrok;
    const requiresAuth =
      !isStella &&
      !isLocal &&
      !usesExternalLogin &&
      !connected &&
      Boolean(llmEntry);
    const supportsApiKey =
      Boolean(llmEntry) &&
      !isApiKeyOnlyPlaceholder(llmEntry?.placeholder ?? "");
    const supportsOAuth = Boolean(oauthEntry);
    const sectionDisabled = disabled || disabledProviderSet.has(tab.key);
    const removable = Boolean(apiKey) || Boolean(oauthCred);
    const armed = signOutArmed === tab.key;
    const isSigningOut = signingOut === tab.key;
    const expanded = expandedProvider === tab.key;
    // Local + connected OpenRouter offer a custom-model entry, tucked behind
    // a header toggle so the section doesn't open expanded by default.
    const hasCustomInputs = isLocal || isOpenRouter;

    const authDescription =
      supportsOAuth && supportsApiKey
        ? "Sign in or paste an API key. Credentials stay on this device."
        : supportsOAuth
          ? "Credentials stay on this device."
          : "Your API key stays on this device.";

    const restrictThisStella = isStella && restrictStellaPicks;
    const showDefaultRow = !hideDefaultRow && isStella && !trimmedQuery;
    // Models stay visible before the provider is connected; picking one
    // opens the connect flow instead of selecting.
    const handleRowPick = requiresAuth
      ? () => toggleExpanded(expanded ? null : tab.key)
      : handlePick;

    return (
      <div
        key={tab.key}
        className="model-picker-group"
        role="group"
        aria-label={tab.label}
      >
        <div
          className="model-picker-group-head"
          title={
            disabledProviderSet.has(tab.key)
              ? disabledProviderReason
              : undefined
          }
        >
          <span
            className="model-picker-group-bar"
            data-on={connected || undefined}
            aria-hidden
          />
          {hideProviderLabel ? null : (
            <>
              <span className="model-picker-group-icon" aria-hidden>
                <BrandIcon brand={tab.key} size={13} />
              </span>
              <span className="model-picker-group-label">{tab.label}</span>
            </>
          )}
          <span className="model-picker-group-rule" aria-hidden />
          {requiresAuth ? (
            <button
              type="button"
              className="model-picker-group-connect"
              data-open={expanded || undefined}
              onClick={() => toggleExpanded(expanded ? null : tab.key)}
              disabled={sectionDisabled}
            >
              {expanded ? "Cancel" : supportsOAuth ? "Sign in" : "Add key"}
            </button>
          ) : (
            <>
              {hasCustomInputs ? (
                <button
                  type="button"
                  className="model-picker-group-connect"
                  data-open={expanded || undefined}
                  onClick={() => toggleExpanded(expanded ? null : tab.key)}
                  disabled={sectionDisabled}
                >
                  {expanded ? "Cancel" : "Custom"}
                </button>
              ) : null}
              {removable ? (
                <button
                  type="button"
                  className="model-picker-group-signout"
                  data-armed={armed || undefined}
                  disabled={isSigningOut}
                  aria-label={
                    armed
                      ? `Click again to sign out of ${tab.label}`
                      : `Sign out of ${tab.label}`
                  }
                  title={
                    armed
                      ? "Click again to confirm"
                      : `Sign out of ${tab.label}`
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleSignOut(tab.key);
                  }}
                >
                  {armed ? (
                    <Check size={13} strokeWidth={2} aria-hidden />
                  ) : (
                    <LogOut size={13} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
              ) : isGrok ? (
                <span className="model-picker-group-note">Uses grok login</span>
              ) : null}
            </>
          )}
        </div>

        {requiresAuth && expanded ? (
          <div className="model-picker-connect">
            <p className="model-picker-connect-hint">{authDescription}</p>
            {supportsOAuth ? (
              <button
                type="button"
                className="model-picker-connect-oauth"
                onClick={() => handleLoginOAuth(tab.key)}
                disabled={oauthProvider === tab.key || sectionDisabled}
              >
                <LogIn size={13} strokeWidth={1.75} aria-hidden />
                {oauthProvider === tab.key
                  ? "Opening…"
                  : `Sign in with ${tab.label}`}
              </button>
            ) : null}
            {supportsApiKey ? (
              <div className="model-picker-connect-field">
                <KeyRound size={13} strokeWidth={1.75} aria-hidden />
                <input
                  type="password"
                  placeholder={llmEntry?.placeholder ?? "API key"}
                  value={draftKey}
                  onChange={(e) => setDraftKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveKey(tab.key, tab.label);
                  }}
                  autoFocus={!supportsOAuth}
                  disabled={sectionDisabled}
                  aria-label={`${tab.label} API key`}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="model-picker-connect-go"
                  onClick={() => handleSaveKey(tab.key, tab.label)}
                  disabled={
                    !draftKey.trim() ||
                    savingProvider === tab.key ||
                    sectionDisabled
                  }
                >
                  {savingProvider === tab.key ? "Saving…" : "Save"}
                </button>
              </div>
            ) : null}
            {authError ? (
              <p className="model-picker-connect-error" role="alert">
                {authError}
              </p>
            ) : null}
          </div>
        ) : null}
        <>
          {isLocal && expanded ? (
            <div className="model-picker-connect">
              <p className="model-picker-connect-hint">
                Use any local OpenAI-compatible server. Ollama usually runs at
                the URL below.
              </p>
              <div className="model-picker-connect-field">
                <input
                  placeholder={DEFAULT_LOCAL_BASE_URL}
                  value={localBaseUrl}
                  onChange={(e) => setLocalBaseUrl(e.target.value)}
                  disabled={sectionDisabled}
                  aria-label="Local server URL"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="model-picker-connect-field">
                <input
                  placeholder="llama3.2"
                  value={localModelId}
                  onChange={(e) => setLocalModelId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmitLocal();
                  }}
                  disabled={sectionDisabled}
                  aria-label="Local model name"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="model-picker-connect-go"
                  onClick={handleSubmitLocal}
                  disabled={!localModelId.trim() || sectionDisabled}
                >
                  Use
                </button>
              </div>
            </div>
          ) : null}

          {isOpenRouter && expanded ? (
            <div className="model-picker-connect">
              <p className="model-picker-connect-hint">
                OpenRouter accepts any <code>vendor/model</code> id. Type one to
                use it directly.
              </p>
              <div className="model-picker-connect-field">
                <input
                  placeholder="anthropic/claude-opus-4.7"
                  value={openRouterCustomId}
                  onChange={(e) => setOpenRouterCustomId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmitOpenRouter();
                  }}
                  disabled={sectionDisabled}
                  aria-label="OpenRouter model id"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="model-picker-connect-go"
                  onClick={handleSubmitOpenRouter}
                  disabled={!openRouterCustomId.trim() || sectionDisabled}
                >
                  Use
                </button>
              </div>
            </div>
          ) : null}

          <div className="model-picker-models">
            {showDefaultRow ? (
              <button
                type="button"
                role="option"
                aria-selected={isDefaultSelected}
                className="model-picker-model model-picker-model--default"
                data-selected={isDefaultSelected || undefined}
                onClick={(event) =>
                  handlePick(DEFAULT_TARGET, event.currentTarget)
                }
                disabled={sectionDisabled}
              >
                <span className="model-picker-model-text">
                  <span className="model-picker-model-name">
                    {defaultLabel}
                  </span>
                </span>
                {!hideSelectionCheck && isDefaultSelected ? (
                  <Check size={13} className="model-picker-model-check" />
                ) : null}
              </button>
            ) : null}
            {models.map((model) => {
              const selected = !isDefaultSelected && model.id === value;
              const rowRestricted =
                restrictThisStella &&
                model.provider === STELLA_PROVIDER_KEY &&
                !selected &&
                model.allowedForAudience === false;
              return (
                <ModelRow
                  key={model.id}
                  model={model}
                  selected={selected}
                  rowRestricted={rowRestricted}
                  restrictedPlanLabel={restrictedPlanLabel ?? null}
                  restrictedReason={
                    rowRestricted && !restrictedPlanLabel
                      ? (disabledProviderReason ?? null)
                      : null
                  }
                  onPick={handleRowPick}
                  disabled={sectionDisabled}
                  favorite={favorites.includes(model.id)}
                  showFavorite={Boolean(favoriteScope)}
                  onToggleFavorite={toggleFavorite}
                  reasoningEffort={reasoningEffort}
                  onSelectReasoning={onSelectReasoning}
                  hideSelectionCheck={hideSelectionCheck}
                />
              );
            })}
          </div>
        </>
      </div>
    );
  };

  return (
    <div
      className="model-picker-shell"
      data-disabled={disabled || undefined}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="model-picker-pane-inner">
        {hideSelectedTitle ? null : (
          <header className="model-picker-pane-header">
            <div className="model-picker-pane-title">
              <span className="model-picker-pane-kicker">
                {selectedHeaderKicker ?? "Selected"}
              </span>
              <span className="model-picker-pane-current" title={currentLabel}>
                {currentLabel}
              </span>
            </div>
          </header>
        )}

        <div className="model-picker-search">
          <Search size={13} strokeWidth={1.75} aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search models"
            disabled={disabled}
          />
        </div>

        <div className="model-picker-groups" role="listbox" aria-live="polite">
          {sections.length === 0 ? (
            <div className="model-picker-empty">
              {tabs.length === 0
                ? "No models available yet."
                : "No models match."}
            </div>
          ) : (
            sections.map(({ tab, models }) => renderSection(tab, models))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model row
// ---------------------------------------------------------------------------

type ModelRowProps = {
  model: CatalogModel;
  selected: boolean;
  rowRestricted: boolean;
  restrictedPlanLabel: string | null;
  restrictedReason: string | null;
  onPick: (modelId: string, anchor?: HTMLElement) => void;
  disabled: boolean;
  favorite: boolean;
  showFavorite: boolean;
  onToggleFavorite: (modelId: string) => void;
  reasoningEffort?: ReasoningEffort;
  onSelectReasoning?: (modelId: string, effort: ReasoningEffort) => void;
  hideSelectionCheck: boolean;
};

const ModelRow = memo(function ModelRow({
  model,
  selected,
  rowRestricted,
  restrictedPlanLabel,
  restrictedReason,
  onPick,
  disabled,
  favorite,
  showFavorite,
  onToggleFavorite,
  reasoningEffort,
  onSelectReasoning,
  hideSelectionCheck,
}: ModelRowProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const showReasoning = Boolean(onSelectReasoning);
  const hasActions = showReasoning || showFavorite;
  const isStellaModel = model.provider === STELLA_PROVIDER_KEY;
  const displayName = isStellaModel ? getStellaDisplayName(model) : model.name;
  const subtitle = isStellaModel
    ? getStellaSubtitle(model)
    : model.upstreamModel && model.upstreamModel !== model.name
      ? model.upstreamModel
      : model.id !== model.name
        ? model.id
        : null;

  return (
    <div className="model-picker-model-row">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={rowRestricted || undefined}
        className="model-picker-model"
        data-selected={selected || undefined}
        data-restricted={rowRestricted || undefined}
        title={
          rowRestricted && restrictedPlanLabel
            ? `Not available on the ${restrictedPlanLabel} plan`
            : rowRestricted
              ? (restrictedReason ?? undefined)
              : undefined
        }
        onClick={(event) => onPick(model.id, event.currentTarget)}
        disabled={disabled || rowRestricted}
      >
        <span className="model-picker-model-text">
          <span className="model-picker-model-name">{displayName}</span>
          {subtitle ? (
            <span className="model-picker-model-sub">{subtitle}</span>
          ) : null}
        </span>
        {!hideSelectionCheck && selected ? (
          <Check size={13} className="model-picker-model-check" />
        ) : null}
      </button>
      {hasActions ? (
        <div
          className="model-picker-model-actions"
          data-open={reasoningOpen || undefined}
        >
          {showReasoning ? (
            <DropdownMenu open={reasoningOpen} onOpenChange={setReasoningOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="model-picker-model-reason"
                  data-active={
                    (selected &&
                      reasoningEffort &&
                      reasoningEffort !== "default") ||
                    undefined
                  }
                  aria-label="Reasoning effort"
                  title="Reasoning effort"
                  disabled={disabled || rowRestricted}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Lightbulb size={14} strokeWidth={1.75} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" sideOffset={6}>
                <DropdownMenuRadioGroup
                  value={reasoningEffort ?? "default"}
                  onValueChange={(value) =>
                    onSelectReasoning?.(model.id, value as ReasoningEffort)
                  }
                >
                  {REASONING_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem key={option.id} value={option.id}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showFavorite ? (
            <button
              type="button"
              className="model-picker-model-star"
              data-favorite={favorite || undefined}
              aria-pressed={favorite}
              aria-label={favorite ? "Remove favorite" : "Add favorite"}
              title={favorite ? "Remove favorite" : "Favorite — pin to top"}
              disabled={disabled || rowRestricted}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite(model.id);
              }}
            >
              <Star size={14} strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
