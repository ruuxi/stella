import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  Check,
  KeyRound,
  Lightbulb,
  LogIn,
  LogOut,
  Search,
  Star,
} from "lucide-react";
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
} from "@/shell/display/engine-model-favorites";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  searchCatalogModels,
  type CatalogModel,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import {
  compareProviderRailOrder,
  CURSOR_PROVIDER_KEY,
  LLM_PROVIDERS,
  isApiKeyOnlyPlaceholder,
  type LlmProviderEntry,
} from "@/global/settings/lib/llm-providers";

export type CursorModelOption = {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
};

type CursorProviderConfig = {
  hasApiKey: boolean;
  models: readonly CursorModelOption[];
  modelsLoading: boolean;
  selectedModelId: string;
  apiKeyDraft: string;
  modelDraft: string;
  savingKey: boolean;
  savingModel: boolean;
  onApiKeyDraftChange: (value: string) => void;
  onModelDraftChange: (value: string) => void;
  onSaveApiKey: () => void;
  onRefreshModels: () => void;
  onPickModel: (modelId: string, anchor?: HTMLElement) => void;
  onSaveManualModel: () => void;
};
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
  /** When set, only these provider keys appear in the rail. */
  visibleProviders?: readonly string[];
  /** When set, enables per-model favorites pinned to the top of each pane. */
  favoriteScope?: string;
  /** Cursor SDK provider (API key + model list) for the Agents tab. */
  cursorProvider?: CursorProviderConfig;
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
   * (anonymous / free / Go). Non-default rows on the Stella tab are
   * disabled; BYOK providers stay fully interactive.
   */
  restrictStellaPicks?: boolean;
  restrictedPlanLabel?: string | null;
  ariaLabel?: string;
  /**
   * When true, the leading "Default …" row on the Stella tab is
   * suppressed. Used by the global Models settings page, where the
   * picker has no single-agent context so "default" doesn't apply.
   */
  hideDefaultRow?: boolean;
  /**
   * When set, replaces the "Selected …" header kicker on the right
   * pane. The Models settings page uses this to swap the affordance
   * from "currently selected" to "click a model to assign".
   */
  selectedHeaderKicker?: string;
  /** When true, the "Selected …" title is hidden (badge still shows). */
  hideSelectedTitle?: boolean;
  /** When true, only the Stella provider can be picked; other provider tabs stay visible but disabled. */
  disableNonStellaProviders?: boolean;
  disabledProviderReason?: string;
}

function buildProviderTabs(
  groups: readonly ProviderGroup[],
  visibleProviders: readonly string[] | undefined,
  includeCursorProvider: boolean,
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
  if (includeCursorProvider && !tabs.has(CURSOR_PROVIDER_KEY)) {
    const cursorEntry = LLM_PROVIDERS.find(
      (entry) => entry.key === CURSOR_PROVIDER_KEY,
    );
    tabs.set(CURSOR_PROVIDER_KEY, {
      key: CURSOR_PROVIDER_KEY,
      label: cursorEntry?.label ?? "Cursor",
      models: [],
      llmEntry: cursorEntry,
    });
  }
  return Array.from(tabs.values()).sort((a, b) =>
    compareProviderRailOrder(a.key, b.key, a.label, b.label),
  );
}

function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : STELLA_PROVIDER_KEY;
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
  disableNonStellaProviders = false,
  disabledProviderReason,
  visibleProviders,
  favoriteScope,
  cursorProvider,
}: ProviderModelPanelProps) {
  const credentials = useLlmCredentials();
  const tabs = useMemo(
    () =>
      buildProviderTabs(
        groups,
        visibleProviders,
        Boolean(cursorProvider),
      ),
    [cursorProvider, groups, visibleProviders],
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
  const fallbackTab =
    tabs.find((tab) => !disabledProviderSet.has(tab.key))?.key ??
    tabs[0]?.key ??
    STELLA_PROVIDER_KEY;
  const initialTab = useMemo(() => {
    if (!value) return fallbackTab;
    const provider = providerOf(value);
    return tabs.some(
      (tab) => tab.key === provider && !disabledProviderSet.has(tab.key),
    )
      ? provider
      : fallbackTab;
  }, [disabledProviderSet, fallbackTab, tabs, value]);

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
  // (e.g. the user toggles agents in the parent), re-anchor the rail to
  // that model's provider so the right pane reflects the active selection.
  // Done by comparing previous vs current `initialTab` during render rather
  // than via a `setState`-in-`useEffect`, which would cause an extra render
  // and could lag a frame behind the prop change.
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab);
  if (
    prevInitialTab !== initialTab ||
    (disabledProviderSet.has(activeProvider) && activeProvider !== initialTab)
  ) {
    setPrevInitialTab(initialTab);
    setActiveProvider(initialTab);
    setQuery("");
    setDraftKey("");
    setAuthError(null);
    setOpenRouterCustomId("");
    setLocalBaseUrl(DEFAULT_LOCAL_BASE_URL);
    setLocalModelId("");
  }

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeProvider) ?? tabs[0],
    [activeProvider, tabs],
  );
  const filteredModels = useMemo(() => {
    if (!activeTab) return [];
    const trimmed = query.trim();
    const searched = trimmed
      ? searchCatalogModels(activeTab.models, trimmed)
      : activeTab.models;
    return favoriteScope ? sortByFavorites(searched, favorites) : searched;
  }, [activeTab, favoriteScope, favorites, query]);

  const toggleFavorite = useCallback(
    (modelId: string) => {
      if (!favoriteScope) return;
      setFavorites(toggleEngineModelFavorite(favoriteScope, modelId));
    },
    [favoriteScope],
  );

  const isProviderConnected = useCallback(
    (providerKey: string) => {
      if (providerKey === STELLA_PROVIDER_KEY) return true;
      if (providerKey === CURSOR_PROVIDER_KEY) {
        return Boolean(cursorProvider?.hasApiKey);
      }
      if (findApiKey(credentials.apiKeys, providerKey)) return true;
      if (findOauthCredential(credentials.oauthCredentials, providerKey))
        return true;
      return false;
    },
    [
      credentials.apiKeys,
      credentials.oauthCredentials,
      cursorProvider?.hasApiKey,
    ],
  );

  const handlePick = useCallback(
    (modelId: string, anchor?: HTMLElement) => {
      if (disabled) return;
      onSelect(modelId === DEFAULT_TARGET ? "" : modelId, anchor);
    },
    [disabled, onSelect],
  );

  // Rail sign-out: a connected provider shows a hover log-out icon on its
  // right. First click arms it (visual confirm), a second click within the
  // window actually drops the API key + OAuth session for that provider.
  const [signOutArmed, setSignOutArmed] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const signOutTimerRef = useRef<number | null>(null);

  const handleRailSignOut = useCallback(
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
      <aside className="model-picker-rail" role="tablist">
        {tabs.map((tab) => {
          const isActive = tab.key === activeProvider;
          const connected = isProviderConnected(tab.key);
          // Only providers with a stored credential we can drop get a
          // sign-out affordance — Stella (always-on) and Cursor (managed in
          // its own pane) have nothing removable here.
          const removable =
            Boolean(findApiKey(credentials.apiKeys, tab.key)) ||
            Boolean(findOauthCredential(credentials.oauthCredentials, tab.key));
          const armed = signOutArmed === tab.key;
          const isSigningOut = signingOut === tab.key;
          return (
            <div key={tab.key} className="model-picker-rail-item-wrap">
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="model-picker-rail-item"
                data-active={isActive || undefined}
                title={
                  disabledProviderSet.has(tab.key)
                    ? disabledProviderReason
                    : undefined
                }
                onClick={() => {
                  setActiveProvider(tab.key);
                  setQuery("");
                  setDraftKey("");
                  setAuthError(null);
                }}
                disabled={disabled || disabledProviderSet.has(tab.key)}
              >
                <span
                  className="model-picker-rail-bar"
                  data-on={connected || undefined}
                  aria-hidden
                />
                <span className="model-picker-rail-label">{tab.label}</span>
              </button>
              {removable ? (
                <button
                  type="button"
                  className="model-picker-rail-signout"
                  data-armed={armed || undefined}
                  disabled={isSigningOut}
                  aria-label={
                    armed
                      ? `Click again to sign out of ${tab.label}`
                      : `Sign out of ${tab.label}`
                  }
                  title={
                    armed ? "Click again to confirm" : `Sign out of ${tab.label}`
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleRailSignOut(tab.key);
                  }}
                >
                  {armed ? (
                    <Check size={13} strokeWidth={2} aria-hidden />
                  ) : (
                    <LogOut size={13} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
              ) : null}
            </div>
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
            restrictStellaPicks={
              activeTab.key === STELLA_PROVIDER_KEY && restrictStellaPicks
            }
            restrictedPlanLabel={restrictedPlanLabel ?? null}
            currentLabel={currentLabel}
            defaultLabel={defaultLabel}
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
            disabled={disabled || disabledProviderSet.has(activeTab.key)}
            hideDefaultRow={hideDefaultRow}
            selectedHeaderKicker={selectedHeaderKicker}
            hideSelectedTitle={hideSelectedTitle}
            favoriteScope={favoriteScope}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            reasoningEffort={reasoningEffort}
            onSelectReasoning={onSelectReasoning}
            disabledProviderReason={disabledProviderReason}
            cursorProvider={
              activeTab.key === CURSOR_PROVIDER_KEY ? cursorProvider : undefined
            }
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
  onPick: (modelId: string, anchor?: HTMLElement) => void;
  isStella: boolean;
  restrictStellaPicks: boolean;
  restrictedPlanLabel: string | null;
  currentLabel: string;
  defaultLabel: string;
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
  hideDefaultRow: boolean;
  selectedHeaderKicker?: string;
  hideSelectedTitle: boolean;
  favoriteScope?: string;
  favorites: readonly string[];
  onToggleFavorite: (modelId: string) => void;
  reasoningEffort?: ReasoningEffort;
  onSelectReasoning?: (modelId: string, effort: ReasoningEffort) => void;
  disabledProviderReason?: string;
  cursorProvider?: CursorProviderConfig;
}

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
        {selected ? (
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

function ProviderPane({
  tab,
  query,
  onQueryChange,
  selectedModelId,
  filteredModels,
  onPick,
  isStella,
  restrictStellaPicks,
  restrictedPlanLabel,
  currentLabel,
  defaultLabel,
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
  hideDefaultRow,
  selectedHeaderKicker,
  hideSelectedTitle,
  favoriteScope,
  favorites,
  onToggleFavorite,
  reasoningEffort,
  onSelectReasoning,
  disabledProviderReason,
  cursorProvider,
}: ProviderPaneProps) {
  const isCursor =
    tab.key === CURSOR_PROVIDER_KEY && cursorProvider !== undefined;
  const llmEntry =
    tab.llmEntry ??
    (!isStella
      ? {
          key: tab.key,
          label: tab.label,
          placeholder: "API key",
        }
      : undefined);
  const providerDisabled = disabled;
  const connected = isCursor
    ? cursorProvider.hasApiKey
    : isStella || Boolean(apiKey) || Boolean(oauthCredential);
  const isLocal = tab.key === LOCAL_PROVIDER_KEY;
  const requiresAuth = isCursor
    ? !cursorProvider.hasApiKey
    : !isStella && !isLocal && !connected && Boolean(llmEntry);
  const supportsApiKey =
    Boolean(llmEntry) && !isApiKeyOnlyPlaceholder(llmEntry?.placeholder ?? "");
  const supportsOAuth = Boolean(oauthProvider);
  const isOpenRouter = tab.key === "openrouter";
  let authHeadline: string;
  let authDescription: string;
  if (supportsOAuth && supportsApiKey) {
    authHeadline = `Connect ${tab.label}`;
    authDescription = `Sign in or add an API key. Credentials stay on this device.`;
  } else if (supportsOAuth) {
    authHeadline = `Sign in to ${tab.label}`;
    authDescription = `Credentials stay on this device.`;
  } else {
    authHeadline = `Add a ${tab.label} API key`;
    authDescription = `The key stays on this device.`;
  }

  const isDefaultSelected = !selectedModelId;
  const cursorFilteredModels = useMemo(() => {
    if (!isCursor) return [];
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [...cursorProvider.models];
    return cursorProvider.models.filter((model) => {
      const haystack = [
        model.id,
        model.displayName,
        model.description ?? "",
        ...(model.aliases ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmed);
    });
  }, [cursorProvider, isCursor, query]);
  const cursorManualChanged =
    isCursor &&
    cursorProvider.modelDraft.trim() !==
      cursorProvider.selectedModelId.trim() &&
    cursorProvider.modelDraft.trim().length > 0;
  const showDefaultRow = !hideDefaultRow && isStella;
  const defaultRow = showDefaultRow ? (
    <button
      type="button"
      role="option"
      aria-selected={isDefaultSelected}
      className="model-picker-model model-picker-model--default"
      data-selected={isDefaultSelected || undefined}
      onClick={(event) => onPick(DEFAULT_TARGET, event.currentTarget)}
      disabled={disabled}
    >
      <span className="model-picker-model-text">
        <span className="model-picker-model-name">{defaultLabel}</span>
      </span>
      {isDefaultSelected ? (
        <Check size={13} className="model-picker-model-check" />
      ) : null}
    </button>
  ) : null;

  return (
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

      {requiresAuth ? (
        isCursor ? (
          <div className="model-picker-auth">
            <h4 className="model-picker-auth-headline">Add a Cursor API key</h4>
            <p className="model-picker-pane-desc">
              The key stays on this device.
            </p>
            <div className="model-picker-auth-row">
              <KeyRound size={13} aria-hidden />
              <TextField
                label="Cursor API key"
                hideLabel
                type="password"
                placeholder={llmEntry?.placeholder ?? "Cursor API key"}
                value={cursorProvider.apiKeyDraft}
                onChange={(e) =>
                  cursorProvider.onApiKeyDraftChange(e.target.value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") cursorProvider.onSaveApiKey();
                }}
                autoFocus
                disabled={disabled}
              />
              <Button
                type="button"
                variant="primary"
                size="small"
                className="model-picker-key-save"
                aria-label="Save Cursor API key"
                onClick={cursorProvider.onSaveApiKey}
                disabled={
                  !cursorProvider.apiKeyDraft.trim() ||
                  cursorProvider.savingKey ||
                  disabled
                }
              >
                <Check size={15} aria-hidden />
              </Button>
            </div>
          </div>
        ) : (
          <div className="model-picker-auth">
            <h4 className="model-picker-auth-headline">{authHeadline}</h4>
            <p className="model-picker-pane-desc">{authDescription}</p>
            {supportsOAuth ? (
              <div className="model-picker-auth-row">
                <LogIn size={13} aria-hidden />
                <Button
                  type="button"
                  variant="ghost"
                  className="model-picker-signin"
                  onClick={onLoginOAuth}
                  disabled={oauthInFlight || disabled}
                >
                  {oauthInFlight ? "Opening…" : "Sign in"}
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
                  disabled={providerDisabled}
                />
                <Button
                  type="button"
                  variant="primary"
                  size="small"
                  className="model-picker-key-save"
                  aria-label={`Save ${tab.label} API key`}
                  onClick={onSaveKey}
                  disabled={!draftKey.trim() || saving || providerDisabled}
                >
                  <Check size={15} aria-hidden />
                </Button>
              </div>
            ) : null}
            {authError ? (
              <p className="model-picker-pane-error" role="alert">
                {authError}
              </p>
            ) : null}
          </div>
        )
      ) : (
        <>
          {isCursor ? (
            <>
              {cursorProvider.models.length > 0 ? (
                <>
                  <div className="model-picker-search">
                    <Search size={13} strokeWidth={1.75} aria-hidden />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => onQueryChange(e.target.value)}
                      placeholder="Search Cursor…"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Search Cursor models"
                      disabled={providerDisabled}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={cursorProvider.onRefreshModels}
                      disabled={
                        cursorProvider.modelsLoading || providerDisabled
                      }
                    >
                      {cursorProvider.modelsLoading ? "Refreshing…" : "Refresh"}
                    </Button>
                  </div>
                  <div
                    className="model-picker-models"
                    role="listbox"
                    aria-label="Cursor models"
                    aria-busy={cursorProvider.modelsLoading || undefined}
                  >
                    {cursorFilteredModels.length === 0 ? (
                      <div className="model-picker-empty">No models match.</div>
                    ) : (
                      cursorFilteredModels.map((model) => {
                        const selected =
                          model.id === cursorProvider.selectedModelId ||
                          model.aliases?.includes(
                            cursorProvider.selectedModelId,
                          );
                        const subtitle =
                          model.aliases?.[0] ?? model.description ?? model.id;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className="model-picker-model"
                            data-selected={selected || undefined}
                            disabled={providerDisabled}
                            onClick={(event) =>
                              cursorProvider.onPickModel(
                                model.id,
                                event.currentTarget,
                              )
                            }
                          >
                            <span className="model-picker-model-text">
                              <span className="model-picker-model-name">
                                {model.displayName || model.id}
                              </span>
                              {subtitle ? (
                                <span className="model-picker-model-sub">
                                  {subtitle}
                                </span>
                              ) : null}
                            </span>
                            {selected ? (
                              <Check
                                size={13}
                                className="model-picker-model-check"
                              />
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                <div className="model-picker-openrouter">
                  <p className="model-picker-pane-desc">
                    {cursorProvider.modelsLoading
                      ? "Loading Cursor models…"
                      : "No models available — enter one manually."}
                  </p>
                  <div className="model-picker-auth-row">
                    <TextField
                      label="Cursor model"
                      hideLabel
                      placeholder="composer-2"
                      value={cursorProvider.modelDraft}
                      onChange={(e) =>
                        cursorProvider.onModelDraftChange(e.target.value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          cursorProvider.onSaveManualModel();
                      }}
                      spellCheck={false}
                      disabled={providerDisabled}
                    />
                    <Button
                      type="button"
                      variant="primary"
                      onClick={cursorProvider.onSaveManualModel}
                      disabled={
                        disabled ||
                        cursorProvider.savingModel ||
                        !cursorManualChanged
                      }
                    >
                      {cursorProvider.savingModel ? "Saving…" : "Use model"}
                    </Button>
                  </div>
                  {cursorProvider.hasApiKey ? (
                    <div className="model-picker-auth-row model-picker-auth-row--end">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={cursorProvider.onRefreshModels}
                        disabled={cursorProvider.modelsLoading || disabled}
                      >
                        {cursorProvider.modelsLoading
                          ? "Refreshing…"
                          : "Refresh models"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </>
          ) : null}

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
                  disabled={providerDisabled}
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
                  disabled={!localModelId.trim() || providerDisabled}
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
                  disabled={providerDisabled}
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={onSubmitOpenRouterCustomId}
                  disabled={!openRouterCustomId.trim() || providerDisabled}
                >
                  Use model
                </Button>
              </div>
              <div className="model-picker-pane-divider">
                <span>or pick from the list</span>
              </div>
            </div>
          ) : null}

          {!isCursor ? (
            <>
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
                {defaultRow}
                {filteredModels.length === 0
                  ? defaultRow
                    ? null
                    : (
                        <div className="model-picker-empty">
                          {tab.models.length === 0
                            ? `No ${tab.label} models available yet.`
                            : "No models match."}
                        </div>
                      )
                  : filteredModels.map((model) => {
                      const selected =
                        !isDefaultSelected && model.id === selectedModelId;
                      const rowRestricted =
                        restrictStellaPicks &&
                        model.provider === STELLA_PROVIDER_KEY &&
                        !selected &&
                        model.allowedForAudience === false;
                      return (
                        <ModelRow
                          key={model.id}
                          model={model}
                          selected={selected}
                          rowRestricted={rowRestricted}
                          restrictedPlanLabel={restrictedPlanLabel}
                          restrictedReason={
                            rowRestricted && !restrictedPlanLabel
                              ? (disabledProviderReason ?? null)
                              : null
                          }
                          onPick={onPick}
                          disabled={providerDisabled}
                          favorite={favorites.includes(model.id)}
                          showFavorite={Boolean(favoriteScope)}
                          onToggleFavorite={onToggleFavorite}
                          reasoningEffort={reasoningEffort}
                          onSelectReasoning={onSelectReasoning}
                        />
                      );
                    })}
              </div>
            </>
          ) : null}
        </>
      )}

      {!requiresAuth && (llmEntry || isCursor) ? (
        <footer className="model-picker-pane-footer">
          {isCursor && cursorProvider.hasApiKey ? (
            <span className="model-picker-pane-foot-text">
              Using your saved API key
            </span>
          ) : apiKey || oauthCredential ? (
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
