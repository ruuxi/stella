import {
  lazy,
  Suspense,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getConfigurableAgents,
  getDefaultModelOptionLabel,
  normalizeModelOverrides,
  type ModelDefaultEntry,
} from "@/global/settings/lib/model-defaults";
import type { LocalLlmCredentialSummary } from "@/shared/types/electron";
import type { LegalDocument } from "@/global/legal/legal-text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { NativeSelect } from "@/ui/native-select";
import { BillingTab } from "@/global/settings/BillingTab";
import { AudioTab } from "@/global/settings/AudioTab";
import { PhoneAccessCard } from "@/global/settings/PhoneAccessCard";
import { ConnectionsTab } from "@/global/settings/ConnectionsTab";
import { hasBillingCheckoutCompletionMarker } from "@/global/settings/lib/billing-checkout";
import "@/global/settings/settings.css";

const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({
    default: m.LegalDialog,
  })),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsTab = "basic" | "models" | "audio" | "billing" | "connections";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERAL_AGENT_ENGINE_OPTIONS = [
  { id: "default", name: "Stella" },
  { id: "claude_code_local", name: "Claude Code" },
] as const;

const MAX_AGENT_CONCURRENCY_OPTIONS = Array.from(
  { length: 24 },
  (_, index) => index + 1,
);

const LLM_PROVIDERS = [
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { key: "openai", label: "OpenAI", placeholder: "sk-..." },
  { key: "openai-codex", label: "OpenAI Codex", placeholder: "eyJ..." },
  { key: "google", label: "Google", placeholder: "AIza..." },
  { key: "kimi-coding", label: "Kimi (Moonshot AI)", placeholder: "sk-..." },
  { key: "zai", label: "Z.AI", placeholder: "..." },
  { key: "xai", label: "xAI", placeholder: "xai-..." },
  { key: "groq", label: "Groq", placeholder: "gsk_..." },
  { key: "mistral", label: "Mistral", placeholder: "..." },
  { key: "cerebras", label: "Cerebras", placeholder: "..." },
  { key: "openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
  { key: "vercel-ai-gateway", label: "Vercel AI Gateway", placeholder: "..." },
  { key: "opencode", label: "OpenCode Zen", placeholder: "..." },
] as const;

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "basic", label: "Basic" },
  { key: "models", label: "Models" },
  { key: "audio", label: "Audio" },
  { key: "connections", label: "Connections" },
  { key: "billing", label: "Billing" },
];

function getSettingsErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Basic Tab
// ---------------------------------------------------------------------------

function BasicTab({
  onSignOut,
  onOpenLegal,
}: {
  onSignOut?: () => void;
  onOpenLegal?: (doc: LegalDocument) => void;
}) {
  return (
    <div className="settings-tab-content">
      <PhoneAccessCard />
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Storage</div>
            <div className="settings-row-sublabel">
              Local only. Conversations stay on this device.
            </div>
            <div className="settings-row-sublabel">
              Cloud sync is not available in the app right now.
            </div>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Sign Out</div>
            <div className="settings-row-sublabel">
              Sign out of your account
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={onSignOut}
            >
              Sign Out
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete Data</div>
            <div className="settings-row-sublabel">
              Erase all conversations and memories.
            </div>
            <div className="settings-row-sublabel">
              This action is not available in the desktop app yet.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              disabled
            >
              Delete
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete Account</div>
            <div className="settings-row-sublabel">
              Permanently remove your account and all data.
            </div>
            <div className="settings-row-sublabel">
              This action is not available in the desktop app yet.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              disabled
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Legal</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Terms of Service</div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("terms")}
            >
              View
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Privacy Policy</div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("privacy")}
            >
              View
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models Tab
// ---------------------------------------------------------------------------

function ModelConfigSection() {
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
  const setOverride = useMutation(api.data.preferences.setModelOverride);
  const clearOverride = useMutation(api.data.preferences.clearModelOverride);
  const generalAgentEngine = useQuery(
    api.data.preferences.getGeneralAgentEngine,
    shouldQueryPreferences,
  ) as "default" | "claude_code_local" | undefined;
  const setGeneralAgentEngine = useMutation(
    api.data.preferences.setGeneralAgentEngine,
  );
  const selfModAgentEngine = useQuery(
    api.data.preferences.getSelfModAgentEngine,
    shouldQueryPreferences,
  ) as "default" | "claude_code_local" | undefined;
  const setSelfModAgentEngine = useMutation(
    api.data.preferences.setSelfModAgentEngine,
  );
  const maxAgentConcurrency = useQuery(
    api.data.preferences.getMaxAgentConcurrency,
    shouldQueryPreferences,
  ) as number | undefined;
  const setMaxAgentConcurrency = useMutation(
    api.data.preferences.setMaxAgentConcurrency,
  );
  const { groups } = useModelCatalog();
  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const group of groups) {
      for (const model of group.models) {
        next.set(model.id, model.name);
        if (model.upstreamModel) {
          next.set(model.upstreamModel, model.name);
        }
      }
    }
    return next;
  }, [groups]);
  const defaultModelMap = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModelMap = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );

  const serverOverrides = useMemo<Record<string, string>>(() => {
    if (!overridesJson) {
      return {};
    }

    try {
      return normalizeModelOverrides(
        JSON.parse(overridesJson) as Record<string, string>,
        defaultModelMap,
      );
    } catch {
      return {};
    }
  }, [defaultModelMap, overridesJson]);
  const [localOverrides, setLocalOverrides] = useState<
    Record<string, string | null>
  >({});
  const [localGeneralAgentEngine, setLocalGeneralAgentEngine] = useState<
    "default" | "claude_code_local" | null
  >(null);
  const [localSelfModAgentEngine, setLocalSelfModAgentEngine] = useState<
    "default" | "claude_code_local" | null
  >(null);
  const [localMaxAgentConcurrency, setLocalMaxAgentConcurrency] = useState<
    number | null
  >(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [modelConfigError, setModelConfigError] = useState<string | null>(null);
  const [isSavingRuntimePreference, setIsSavingRuntimePreference] =
    useState(false);
  const [isSavingModelPreferences, setIsSavingModelPreferences] =
    useState(false);

  const runtimePreferencesLoaded =
    hasConnectedAccount &&
    generalAgentEngine !== undefined &&
    selfModAgentEngine !== undefined &&
    maxAgentConcurrency !== undefined;
  const modelPreferencesLoaded =
    hasConnectedAccount &&
    modelDefaults !== undefined &&
    overridesJson !== undefined;

  const pendingLocalOverrides = useMemo(() => {
    const next: Record<string, string | null> = {};

    for (const [key, value] of Object.entries(localOverrides)) {
      const serverValue = serverOverrides[key];
      if (value === null && serverValue === undefined) continue;
      if (value !== null && serverValue === value) continue;
      next[key] = value;
    }

    return next;
  }, [localOverrides, serverOverrides]);

  const overrides = useMemo<Record<string, string>>(() => {
    const merged: Record<string, string> = { ...serverOverrides };

    for (const [key, value] of Object.entries(pendingLocalOverrides)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }, [pendingLocalOverrides, serverOverrides]);

  const effectiveGeneralAgentEngine =
    (localGeneralAgentEngine !== null &&
    localGeneralAgentEngine !== generalAgentEngine
      ? localGeneralAgentEngine
      : null) ??
    generalAgentEngine ??
    "default";
  const effectiveSelfModAgentEngine =
    (localSelfModAgentEngine !== null &&
    localSelfModAgentEngine !== selfModAgentEngine
      ? localSelfModAgentEngine
      : null) ??
    selfModAgentEngine ??
    "default";
  const effectiveMaxAgentConcurrency =
    (localMaxAgentConcurrency !== null &&
    localMaxAgentConcurrency !== maxAgentConcurrency
      ? localMaxAgentConcurrency
      : null) ??
    maxAgentConcurrency ??
    24;

  const hasAnyOverride = Object.keys(overrides).length > 0;

  const handleChange = useCallback(
    async (agentType: string, value: string) => {
      if (isSavingModelPreferences) {
        return;
      }

      const previousValue = Object.prototype.hasOwnProperty.call(
        localOverrides,
        agentType,
      )
        ? localOverrides[agentType]
        : undefined;

      setModelConfigError(null);
      setIsSavingModelPreferences(true);

      if (value === "") {
        setLocalOverrides((prev) => ({ ...prev, [agentType]: null }));
        try {
          await clearOverride({ agentType });
        } catch (error) {
          setLocalOverrides((prev) => {
            const next = { ...prev };
            if (previousValue === undefined) {
              delete next[agentType];
            } else {
              next[agentType] = previousValue;
            }
            return next;
          });
          setModelConfigError(
            getSettingsErrorMessage(error, "Failed to update model setting."),
          );
        } finally {
          setIsSavingModelPreferences(false);
        }
      } else {
        setLocalOverrides((prev) => ({ ...prev, [agentType]: value }));
        try {
          await setOverride({ agentType, model: value });
        } catch (error) {
          setLocalOverrides((prev) => {
            const next = { ...prev };
            if (previousValue === undefined) {
              delete next[agentType];
            } else {
              next[agentType] = previousValue;
            }
            return next;
          });
          setModelConfigError(
            getSettingsErrorMessage(error, "Failed to update model setting."),
          );
        } finally {
          setIsSavingModelPreferences(false);
        }
      }
    },
    [clearOverride, isSavingModelPreferences, localOverrides, setOverride],
  );

  const handleResetAll = useCallback(async () => {
    if (isSavingModelPreferences || !hasAnyOverride) {
      return;
    }

    setModelConfigError(null);
    setIsSavingModelPreferences(true);

    const cleared: Record<string, null> = {};
    for (const key of Object.keys(overrides)) {
      cleared[key] = null;
    }
    setLocalOverrides((prev) => ({ ...prev, ...cleared }));

    const keys = Object.keys(overrides);
    const previousLocalOverrides = localOverrides;
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        await clearOverride({ agentType: key });
        return key;
      }),
    );

    const failedKeys = results.flatMap((result, index) =>
      result.status === "rejected" ? [keys[index]] : [],
    );

    if (failedKeys.length > 0) {
      setLocalOverrides((prev) => {
        const next = { ...prev };
        for (const key of failedKeys) {
          if (
            Object.prototype.hasOwnProperty.call(previousLocalOverrides, key)
          ) {
            next[key] = previousLocalOverrides[key] ?? null;
          } else {
            delete next[key];
          }
        }
        return next;
      });
      setModelConfigError(
        failedKeys.length === 1
          ? "Failed to reset one model setting."
          : `Failed to reset ${failedKeys.length} model settings.`,
      );
    }

    setIsSavingModelPreferences(false);
  }, [
    clearOverride,
    hasAnyOverride,
    isSavingModelPreferences,
    localOverrides,
    overrides,
  ]);

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
        await setGeneralAgentEngine({ engine });
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
    [
      isSavingRuntimePreference,
      localGeneralAgentEngine,
      setGeneralAgentEngine,
    ],
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
        await setMaxAgentConcurrency({ value: normalized });
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
    [
      isSavingRuntimePreference,
      localMaxAgentConcurrency,
      setMaxAgentConcurrency,
    ],
  );

  return (
    <>
      <div className="settings-card">
        <h3 className="settings-card-title">Agent Runtime</h3>
        <p className="settings-card-desc">
          Choose how the General and Self Mod agents run on this device.
        </p>
        {!hasConnectedAccount ? (
          <p className="settings-card-desc">
            Sign in to manage runtime settings.
          </p>
        ) : null}
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
              General agent. Local CLI mode requires the corresponding{" "}
              <code>claude</code> CLI.
            </div>
          </div>
          <div className="settings-row-control">
            {runtimePreferencesLoaded ? (
              <NativeSelect
                className="settings-runtime-select"
                value={effectiveGeneralAgentEngine}
                onChange={(e) =>
                  void handleAgentEngineChange("general", e.target.value)
                }
                disabled={isSavingRuntimePreference}
              >
                {GENERAL_AGENT_ENGINE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <NativeSelect
                className="settings-runtime-select"
                value="loading"
                disabled
              >
                <option value="loading">
                  {hasConnectedAccount
                    ? "Loading saved setting..."
                    : "Sign in required"}
                </option>
              </NativeSelect>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Max Agent Concurrency</div>
            <div className="settings-row-sublabel">
              Maximum number of local agent tasks running at once across
              General, Self Mod, and Claude Code.
            </div>
          </div>
          <div className="settings-row-control">
            {runtimePreferencesLoaded ? (
              <NativeSelect
                className="settings-runtime-select"
                value={String(effectiveMaxAgentConcurrency)}
                onChange={(e) =>
                  void handleMaxAgentConcurrencyChange(e.target.value)
                }
                disabled={isSavingRuntimePreference}
              >
                {MAX_AGENT_CONCURRENCY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <NativeSelect
                className="settings-runtime-select"
                value="loading"
                disabled
              >
                <option value="loading">
                  {hasConnectedAccount
                    ? "Loading saved setting..."
                    : "Sign in required"}
                </option>
              </NativeSelect>
            )}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Model Configuration</h3>
          <Button
            type="button"
            variant="ghost"
            className="settings-btn settings-btn--reset-all"
            onClick={() => void handleResetAll()}
            style={{ visibility: hasAnyOverride ? "visible" : "hidden" }}
            disabled={!modelPreferencesLoaded || isSavingModelPreferences}
          >
            {isSavingModelPreferences ? "Resetting..." : "Reset All"}
          </Button>
        </div>
        <p className="settings-card-desc">
          Override the default model for each agent type.
        </p>
        {!hasConnectedAccount ? (
          <p className="settings-card-desc">
            Sign in to manage model settings.
          </p>
        ) : null}
        {modelConfigError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {modelConfigError}
          </p>
        ) : null}
        {hasConnectedAccount && !modelPreferencesLoaded ? (
          <p className="settings-card-desc">Loading saved model settings...</p>
        ) : null}
        {modelPreferencesLoaded &&
          configurableAgents.map((agent) => {
            const current = overrides[agent.key] ?? "";
            return (
              <div key={agent.key} className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-label">{agent.label}</div>
                  <div className="settings-row-sublabel">{agent.desc}</div>
                </div>
                <div className="settings-row-control">
                  {current && (
                    <button
                      className="settings-model-reset-icon"
                      onClick={() => void handleChange(agent.key, "")}
                      title="Reset to default"
                      disabled={isSavingModelPreferences}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12a9 9 0 1 1 3 6.7" />
                        <polyline points="3 7 3 13 9 13" />
                      </svg>
                    </button>
                  )}
                  <NativeSelect
                    className="settings-model-select"
                    value={current}
                    onChange={(e) =>
                      void handleChange(agent.key, e.target.value)
                    }
                    disabled={isSavingModelPreferences}
                  >
                    <option value="">
                      {getDefaultModelOptionLabel(
                        agent.key,
                        defaultModelMap,
                        resolvedDefaultModelMap,
                        modelNamesById,
                      )}
                    </option>
                    {groups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            );
          })}
      </div>
    </>
  );
}

function ApiKeysSection() {
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [llmCredentials, setLlmCredentials] = useState<
    LocalLlmCredentialSummary[]
  >([]);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [removingProvider, setRemovingProvider] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    if (!window.electronAPI?.system.listLlmCredentials) {
      setLlmCredentials([]);
      return;
    }

    const nextCredentials =
      await window.electronAPI.system.listLlmCredentials();
    setLlmCredentials(nextCredentials);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        await loadCredentials();
        if (!cancelled) {
          setCredentialsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCredentialsError(
            error instanceof Error
              ? error.message
              : "Failed to load local API keys.",
          );
          setLlmCredentials([]);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [loadCredentials]);

  const getCredentialForProvider = (providerKey: string) =>
    llmCredentials.find(
      (credential) =>
        credential.provider === providerKey && credential.status === "active",
    );

  const handleSave = useCallback(
    async (providerKey: string, label: string) => {
      if (!keyInput.trim()) return;
      if (!window.electronAPI?.system.saveLlmCredential) {
        setCredentialsError(
          "Local API key storage is unavailable in this window.",
        );
        return;
      }
      setCredentialsError(null);
      setIsSavingKey(true);
      try {
        const saved = await window.electronAPI.system.saveLlmCredential({
          provider: providerKey,
          label,
          plaintext: keyInput.trim(),
        });
        setLlmCredentials((prev) => {
          const next = prev.filter(
            (entry) => entry.provider !== saved.provider,
          );
          next.push(saved);
          return next.sort((a, b) => a.label.localeCompare(b.label));
        });
        setKeyInput("");
        setEditingProvider(null);
      } catch (error) {
        setCredentialsError(
          error instanceof Error
            ? error.message
            : "Failed to save local API key.",
        );
      } finally {
        setIsSavingKey(false);
      }
    },
    [keyInput],
  );

  const handleRemove = useCallback(async (providerKey: string) => {
    if (!window.electronAPI?.system.deleteLlmCredential) {
      setCredentialsError(
        "Local API key storage is unavailable in this window.",
      );
      return;
    }
    setCredentialsError(null);
    setRemovingProvider(providerKey);
    try {
      await window.electronAPI.system.deleteLlmCredential(providerKey);
      setLlmCredentials((prev) =>
        prev.filter((entry) => entry.provider !== providerKey),
      );
    } catch (error) {
      setCredentialsError(
        error instanceof Error
          ? error.message
          : "Failed to remove local API key.",
      );
    } finally {
      setRemovingProvider(null);
    }
  }, []);

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Provider Credentials</h3>
      <p className="settings-card-desc">
        Credentials stay on this device. If Stella has matching local provider
        credentials it calls that provider directly. Otherwise it uses your
        Stella provider access.
      </p>
      {credentialsError ? (
        <p className="settings-card-desc">{credentialsError}</p>
      ) : null}
      {LLM_PROVIDERS.map((provider) => {
        const credential = getCredentialForProvider(provider.key);
        const isEditing = editingProvider === provider.key;
        const isRemoving = removingProvider === provider.key;
        return (
          <div key={provider.key} className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">{provider.label}</div>
              <div className="settings-row-sublabel">
                {credential ? (
                  <span className="settings-key-status">
                    <span className="settings-key-dot settings-key-dot--active" />
                    Key set
                  </span>
                ) : (
                  <span className="settings-key-status">
                    <span className="settings-key-dot settings-key-dot--inactive" />
                    No key
                  </span>
                )}
              </div>
            </div>
            <div className="settings-row-control">
              {isEditing ? (
                <div className="settings-key-input">
                  <TextField
                    label={`${provider.label} API key`}
                    hideLabel={true}
                    type="password"
                    placeholder={provider.placeholder}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        handleSave(provider.key, provider.label);
                      if (e.key === "Escape") {
                        setEditingProvider(null);
                        setKeyInput("");
                      }
                    }}
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="primary"
                    className="settings-btn settings-btn--primary"
                    onClick={() => handleSave(provider.key, provider.label)}
                    disabled={isSavingKey}
                  >
                    {isSavingKey ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn"
                    onClick={() => {
                      setEditingProvider(null);
                      setKeyInput("");
                    }}
                    disabled={isSavingKey}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn"
                    onClick={() => {
                      setEditingProvider(provider.key);
                      setKeyInput("");
                      setCredentialsError(null);
                    }}
                    disabled={isSavingKey || Boolean(removingProvider)}
                  >
                    {credential ? "Update Credential" : "Add Credential"}
                  </Button>
                  {credential && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="settings-btn settings-btn--danger"
                      onClick={() => handleRemove(provider.key)}
                      disabled={isRemoving || isSavingKey}
                    >
                      {isRemoving ? "Removing..." : "Remove"}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ModelsTab() {
  return (
    <div className="settings-tab-content">
      <ModelConfigSection />
      <ApiKeysSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Panel (scroll container with bottom fade)
// ---------------------------------------------------------------------------

function SettingsPanel({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const check = () => {
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      setAtBottom(isAtBottom);
    };

    check();
    el.addEventListener("scroll", check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="settings-panel-wrap" data-at-bottom={atBottom || undefined}>
      <div className="settings-panel" ref={ref}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsDialog
// ---------------------------------------------------------------------------

export const SettingsDialog = ({
  open,
  onOpenChange,
  onSignOut,
}: SettingsDialogProps) => {
  const [selectedTab, setSelectedTab] = useState<SettingsTab>(() =>
    hasBillingCheckoutCompletionMarker() ? "billing" : "basic",
  );
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(
    null,
  );
  const activeTab = hasBillingCheckoutCompletionMarker()
    ? "billing"
    : selectedTab;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="lg" className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogCloseButton />
          </DialogHeader>
          <DialogBody>
            <div className="settings-layout">
              <nav className="settings-sidebar">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`settings-sidebar-tab${activeTab === tab.key ? " settings-sidebar-tab--active" : ""}`}
                    onClick={() => setSelectedTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
              <SettingsPanel>
                {activeTab === "basic" ? (
                  <BasicTab
                    onSignOut={onSignOut}
                    onOpenLegal={setActiveLegalDoc}
                  />
                ) : activeTab === "models" ? (
                  <ModelsTab />
                ) : activeTab === "audio" ? (
                  <AudioTab />
                ) : activeTab === "connections" ? (
                  <ConnectionsTab />
                ) : (
                  <BillingTab />
                )}
              </SettingsPanel>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
      <Suspense fallback={null}>
        <LegalDialog
          document={activeLegalDoc}
          onOpenChange={(open) => {
            if (!open) setActiveLegalDoc(null);
          }}
        />
      </Suspense>
    </>
  );
};

export default SettingsDialog;
