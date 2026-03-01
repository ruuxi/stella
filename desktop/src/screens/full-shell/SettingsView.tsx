import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useAccountMode } from "@/hooks/use-account-mode";
import { useModelCatalog } from "../../hooks/use-model-catalog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/components/dialog";
import "../../styles/settings.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsTab = "basic" | "models";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIGURABLE_AGENTS = [
  { key: "orchestrator", label: "Orchestrator", desc: "Top-level agent that delegates tasks" },
  { key: "general", label: "General", desc: "Full tool access for general tasks" },
  { key: "self_mod", label: "Self-Mod", desc: "Platform self-modification agent" },
  { key: "browser", label: "Browser", desc: "Browser automation via Playwright" },
  { key: "explore", label: "Explore", desc: "Lightweight read-only exploration" },
  { key: "memory", label: "Memory", desc: "Memory search and retrieval" },
] as const;

const AGENT_DEFAULTS: Record<string, string> = {
  orchestrator: "anthropic/claude-opus-4.6",
  general: "anthropic/claude-opus-4.6",
  self_mod: "anthropic/claude-opus-4.6",
  browser: "moonshotai/kimi-k2.5",
  explore: "zai/glm-4.7",
  memory: "zai/glm-4.7",
};

const GENERAL_LOCAL_RUNTIME_OPTIONS = [
  { id: "claude-code/default", name: "Claude Code (Local CLI)" },
];

const GENERAL_AGENT_ENGINE_OPTIONS = [
  { id: "default", name: "Default Runtime" },
  { id: "codex_local", name: "Codex App Server (Local)" },
] as const;

const CODEX_LOCAL_CONCURRENCY_OPTIONS = [1, 2, 3] as const;

const LLM_PROVIDERS = [
  { key: "llm:anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { key: "llm:openai", label: "OpenAI", placeholder: "sk-..." },
  { key: "llm:google", label: "Google", placeholder: "AIza..." },
  { key: "llm:azure", label: "Azure OpenAI", placeholder: "..." },
  { key: "llm:azure-cognitive-services", label: "Azure Cognitive Services", placeholder: "..." },
  { key: "llm:cloudflare-workers-ai", label: "Cloudflare Workers AI", placeholder: "..." },
  { key: "llm:cloudflare-ai-gateway", label: "Cloudflare AI Gateway", placeholder: "..." },
  { key: "llm:vercel", label: "Vercel AI Gateway (Direct)", placeholder: "..." },
  { key: "llm:openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
  { key: "llm:gateway", label: "Vercel AI Gateway", placeholder: "..." },
  { key: "llm:amazon-bedrock", label: "Amazon Bedrock", placeholder: "..." },
  { key: "llm:google-vertex", label: "Google Vertex AI", placeholder: "..." },
  { key: "llm:google-vertex-anthropic", label: "Vertex AI (Anthropic)", placeholder: "..." },
  { key: "llm:gitlab", label: "GitLab Duo", placeholder: "..." },
  { key: "llm:github-copilot", label: "GitHub Copilot", placeholder: "..." },
  { key: "llm:github-copilot-enterprise", label: "GitHub Copilot Enterprise", placeholder: "..." },
  { key: "llm:sap-ai-core", label: "SAP AI Core", placeholder: "..." },
  { key: "llm:opencode", label: "OpenCode Zen", placeholder: "..." },
  { key: "llm:zenmux", label: "ZenMux", placeholder: "..." },
  { key: "llm:cerebras", label: "Cerebras", placeholder: "..." },
  { key: "llm:kilo", label: "Kilo Gateway", placeholder: "..." },
] as const;

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "basic", label: "Basic" },
  { key: "models", label: "Models" },
];

// ---------------------------------------------------------------------------
// Basic Tab
// ---------------------------------------------------------------------------

function BasicTab({ onSignOut }: {
  onSignOut?: () => void;
}) {
  const accountMode = useAccountMode();
  const syncMode = useQuery(
    api.data.preferences.getSyncMode,
    accountMode === "connected" ? {} : "skip",
  ) as "on" | "off" | undefined;
  const setAccountMode = useMutation(api.data.preferences.setAccountMode);
  const setSyncMode = useMutation(api.data.preferences.setSyncMode);
  const [isUpdatingAccountMode, setIsUpdatingAccountMode] = useState(false);
  const [accountModeError, setAccountModeError] = useState<string | null>(null);
  const [isUpdatingSyncMode, setIsUpdatingSyncMode] = useState(false);
  const [syncModeError, setSyncModeError] = useState<string | null>(null);

  const effectiveAccountMode = accountMode ?? "private_local";
  const accountModeLabel =
    effectiveAccountMode === "connected" ? "Connected mode" : "Private Local mode";

  const accountModeDescription =
    effectiveAccountMode === "connected"
      ? "Connectors are enabled."
      : "Connectors and cloud sync are disabled.";
  const effectiveSyncMode = syncMode ?? "on";
  const syncModeLabel = effectiveSyncMode === "on" ? "Sync On" : "Sync Off";
  const syncModeDescription =
    effectiveSyncMode === "on"
      ? "Conversation history is persisted to cloud."
      : "Conversation history stays on this device and is not synced to cloud.";

  const handleToggleAccountMode = useCallback(async () => {
    if (isUpdatingAccountMode) return;

    setAccountModeError(null);
    setIsUpdatingAccountMode(true);
    const nextMode = effectiveAccountMode === "connected" ? "private_local" : "connected";

    try {
      await setAccountMode({ mode: nextMode });
    } catch (error) {
      setAccountModeError(error instanceof Error ? error.message : "Failed to update account mode.");
    } finally {
      setIsUpdatingAccountMode(false);
    }
  }, [effectiveAccountMode, isUpdatingAccountMode, setAccountMode]);

  const handleToggleSyncMode = useCallback(async () => {
    if (effectiveAccountMode !== "connected") return;
    if (isUpdatingSyncMode) return;
    setSyncModeError(null);
    setIsUpdatingSyncMode(true);
    const nextMode = effectiveSyncMode === "on" ? "off" : "on";

    try {
      await setSyncMode({ mode: nextMode });
    } catch (error) {
      setSyncModeError(error instanceof Error ? error.message : "Failed to update sync mode.");
    } finally {
      setIsUpdatingSyncMode(false);
    }
  }, [effectiveAccountMode, effectiveSyncMode, isUpdatingSyncMode, setSyncMode]);

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Account Mode</div>
            <div className="settings-row-sublabel">
              {accountModeLabel}. {accountModeDescription}
            </div>
            {accountModeError ? (
              <div className="settings-row-sublabel">{accountModeError}</div>
            ) : null}
          </div>
          <div className="settings-row-control">
            <button className="settings-btn" onClick={handleToggleAccountMode} disabled={isUpdatingAccountMode}>
              {isUpdatingAccountMode
                ? "Updating..."
                : effectiveAccountMode === "connected"
                  ? "Switch to Private Local"
                  : "Switch to Connected"}
            </button>
          </div>
        </div>
        {effectiveAccountMode === "connected" ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Chat Sync</div>
              <div className="settings-row-sublabel">
                {syncModeLabel}. {syncModeDescription}
              </div>
              {syncModeError ? (
                <div className="settings-row-sublabel">{syncModeError}</div>
              ) : null}
            </div>
            <div className="settings-row-control">
              <button className="settings-btn" onClick={handleToggleSyncMode} disabled={isUpdatingSyncMode}>
                {isUpdatingSyncMode
                  ? "Updating..."
                  : effectiveSyncMode === "on"
                    ? "Turn Sync Off"
                    : "Turn Sync On"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Sign Out</div>
            <div className="settings-row-sublabel">Sign out of your account</div>
          </div>
          <div className="settings-row-control">
            <button className="settings-btn" onClick={onSignOut}>
              Sign Out
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete Data</div>
            <div className="settings-row-sublabel">Erase all conversations and memories</div>
          </div>
          <div className="settings-row-control">
            <button className="settings-btn settings-btn--danger">
              Delete
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete Account</div>
            <div className="settings-row-sublabel">Permanently remove your account and all data</div>
          </div>
          <div className="settings-row-control">
            <button className="settings-btn settings-btn--danger">
              Delete
            </button>
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
  const overridesJson = useQuery(api.data.preferences.getModelOverrides) as string | undefined;
  const setOverride = useMutation(api.data.preferences.setModelOverride);
  const clearOverride = useMutation(api.data.preferences.clearModelOverride);
  const generalAgentEngine = useQuery(api.data.preferences.getGeneralAgentEngine) as
    | "default"
    | "codex_local"
    | undefined;
  const setGeneralAgentEngine = useMutation(api.data.preferences.setGeneralAgentEngine);
  const codexLocalMaxConcurrency = useQuery(api.data.preferences.getCodexLocalMaxConcurrency) as number | undefined;
  const setCodexLocalMaxConcurrency = useMutation(api.data.preferences.setCodexLocalMaxConcurrency);
  const { groups } = useModelCatalog();

  const serverOverrides: Record<string, string> = overridesJson ? JSON.parse(overridesJson) : {};
  const [localOverrides, setLocalOverrides] = useState<Record<string, string | null>>({});
  const [localGeneralAgentEngine, setLocalGeneralAgentEngine] = useState<"default" | "codex_local" | null>(null);
  const [localCodexLocalMaxConcurrency, setLocalCodexLocalMaxConcurrency] = useState<number | null>(null);

  // Merge: local optimistic values take precedence, null means cleared
  const overrides: Record<string, string> = { ...serverOverrides };
  for (const [k, v] of Object.entries(localOverrides)) {
    if (v === null) delete overrides[k];
    else overrides[k] = v;
  }

  // Clear optimistic state once server catches up
  useEffect(() => {
    setLocalOverrides((prev) => {
      const next: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(prev)) {
        const serverVal = serverOverrides[k];
        if (v === null && serverVal === undefined) continue; // server caught up (cleared)
        if (v !== null && serverVal === v) continue; // server caught up (set)
        next[k] = v;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [overridesJson]);

  useEffect(() => {
    if (!localGeneralAgentEngine || !generalAgentEngine) return;
    if (localGeneralAgentEngine === generalAgentEngine) {
      setLocalGeneralAgentEngine(null);
    }
  }, [localGeneralAgentEngine, generalAgentEngine]);

  useEffect(() => {
    if (localCodexLocalMaxConcurrency === null || codexLocalMaxConcurrency === undefined) return;
    if (localCodexLocalMaxConcurrency === codexLocalMaxConcurrency) {
      setLocalCodexLocalMaxConcurrency(null);
    }
  }, [localCodexLocalMaxConcurrency, codexLocalMaxConcurrency]);

  const effectiveGeneralAgentEngine = localGeneralAgentEngine ?? generalAgentEngine ?? "default";
  const effectiveCodexLocalMaxConcurrency = localCodexLocalMaxConcurrency ?? codexLocalMaxConcurrency ?? 3;
  const hasAnyOverride = Object.keys(overrides).length > 0;

  const handleChange = useCallback(
    (agentType: string, value: string) => {
      if (value === "") {
        setLocalOverrides((prev) => ({ ...prev, [agentType]: null }));
        clearOverride({ agentType });
      } else {
        setLocalOverrides((prev) => ({ ...prev, [agentType]: value }));
        setOverride({ agentType, model: value });
      }
    },
    [setOverride, clearOverride],
  );

  const handleResetAll = useCallback(() => {
    const cleared: Record<string, null> = {};
    for (const key of Object.keys(overrides)) {
      cleared[key] = null;
      clearOverride({ agentType: key });
    }
    setLocalOverrides((prev) => ({ ...prev, ...cleared }));
  }, [overrides, clearOverride]);

  const handleGeneralAgentEngineChange = useCallback(
    (value: string) => {
      const engine = value === "codex_local" ? "codex_local" : "default";
      setLocalGeneralAgentEngine(engine);
      setGeneralAgentEngine({ engine });
    },
    [setGeneralAgentEngine],
  );

  const handleCodexLocalMaxConcurrencyChange = useCallback(
    (value: string) => {
      const parsed = Number(value);
      const normalized = Number.isFinite(parsed)
        ? Math.max(1, Math.min(3, Math.floor(parsed)))
        : 3;
      setLocalCodexLocalMaxConcurrency(normalized);
      setCodexLocalMaxConcurrency({ value: normalized });
    },
    [setCodexLocalMaxConcurrency],
  );

  return (
    <>
      <div className="settings-card">
        <h3 className="settings-card-title">General Agent Runtime</h3>
        <p className="settings-card-desc">
          Choose how the general subagent runs on this device.
        </p>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Engine</div>
            <div className="settings-row-sublabel">
              Codex mode requires the local <code>codex</code> CLI.
            </div>
          </div>
          <div className="settings-row-control">
            <select
              className="settings-runtime-select"
              value={effectiveGeneralAgentEngine}
              onChange={(e) => handleGeneralAgentEngineChange(e.target.value)}
            >
              {GENERAL_AGENT_ENGINE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {effectiveGeneralAgentEngine === "codex_local" ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Parallel Codex Sessions</div>
              <div className="settings-row-sublabel">
                Number of general-agent Codex tasks to run in parallel.
              </div>
            </div>
            <div className="settings-row-control">
              <select
                className="settings-runtime-select"
                value={String(effectiveCodexLocalMaxConcurrency)}
                onChange={(e) => handleCodexLocalMaxConcurrencyChange(e.target.value)}
              >
                {CODEX_LOCAL_CONCURRENCY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Model Configuration</h3>
          <button
            className="settings-btn settings-btn--reset-all"
            onClick={handleResetAll}
            style={{ visibility: hasAnyOverride ? "visible" : "hidden" }}
          >
            Reset All
          </button>
        </div>
        <p className="settings-card-desc">Override the default model for each agent type.</p>
        {CONFIGURABLE_AGENTS.map((agent) => {
          const current = overrides[agent.key] ?? "";
          const defaultModel = AGENT_DEFAULTS[agent.key];
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
                    onClick={() => handleChange(agent.key, "")}
                    title="Reset to default"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 1 3 6.7" />
                      <polyline points="3 7 3 13 9 13" />
                    </svg>
                  </button>
                )}
                <select
                  className="settings-model-select"
                  value={current}
                  onChange={(e) => handleChange(agent.key, e.target.value)}
                >
                  <option value="">{defaultModel}</option>
                  {agent.key === "general" && (
                    <optgroup label="local-runtime">
                      {GENERAL_LOCAL_RUNTIME_OPTIONS.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {groups.map((group) => (
                    <optgroup key={group.provider} label={group.provider}>
                      {group.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ApiKeysSection() {
  const secrets = useQuery(api.data.secrets.listSecrets, {}) as
    | Array<{ _id: string; provider: string; label: string; status: string }>
    | undefined;
  const createSecret = useMutation(api.data.secrets.createSecret);
  const deleteSecret = useMutation(api.data.secrets.deleteSecret);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");

  const llmSecrets = (secrets ?? []).filter((s) => s.provider.startsWith("llm:"));

  const getSecretForProvider = (providerKey: string) =>
    llmSecrets.find((s) => s.provider === providerKey && s.status === "active");

  const handleSave = useCallback(
    async (providerKey: string, label: string) => {
      if (!keyInput.trim()) return;
      const existing = llmSecrets.find((s) => s.provider === providerKey);
      if (existing) {
        await deleteSecret({ secretId: existing._id as any });
      }
      await createSecret({
        provider: providerKey,
        label,
        plaintext: keyInput.trim(),
        metadata: undefined,
      });
      setKeyInput("");
      setEditingProvider(null);
    },
    [keyInput, llmSecrets, createSecret, deleteSecret],
  );

  const handleRemove = useCallback(
    async (providerKey: string) => {
      const existing = llmSecrets.find((s) => s.provider === providerKey);
      if (existing) {
        await deleteSecret({ secretId: existing._id as any });
      }
    },
    [llmSecrets, deleteSecret],
  );

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">API Keys</h3>
      <p className="settings-card-desc">
        Bring your own API keys to bypass the gateway and call providers directly.
      </p>
      {LLM_PROVIDERS.map((provider) => {
        const secret = getSecretForProvider(provider.key);
        const isEditing = editingProvider === provider.key;
        return (
          <div key={provider.key} className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">{provider.label}</div>
              <div className="settings-row-sublabel">
                {secret ? (
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
                  <input
                    type="password"
                    placeholder={provider.placeholder}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSave(provider.key, provider.label);
                      if (e.key === "Escape") {
                        setEditingProvider(null);
                        setKeyInput("");
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="settings-btn settings-btn--primary"
                    onClick={() => handleSave(provider.key, provider.label)}
                  >
                    Save
                  </button>
                  <button
                    className="settings-btn"
                    onClick={() => {
                      setEditingProvider(null);
                      setKeyInput("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="settings-btn"
                    onClick={() => {
                      setEditingProvider(provider.key);
                      setKeyInput("");
                    }}
                  >
                    {secret ? "Update Key" : "Add Key"}
                  </button>
                  {secret && (
                    <button
                      className="settings-btn settings-btn--danger"
                      onClick={() => handleRemove(provider.key)}
                    >
                      Remove
                    </button>
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

export const SettingsDialog = ({ open, onOpenChange, onSignOut }: SettingsDialogProps) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>("basic");

  return (
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
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
            <SettingsPanel>
              {activeTab === "basic" ? (
                <BasicTab onSignOut={onSignOut} />
              ) : (
                <ModelsTab />
              )}
            </SettingsPanel>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

export default SettingsDialog;
