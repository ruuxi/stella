import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useModelCatalog } from "@/app/settings/hooks/use-model-catalog";
import {
  getDefaultModelOptionLabel,
  normalizeModelOverrides,
} from "@/app/settings/lib/model-defaults";
import type { LocalLlmCredentialSummary } from "@/types/electron";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/ui/dialog";
import "@/app/settings/settings.css";

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

const GENERAL_AGENT_ENGINE_OPTIONS = [
  { id: "default", name: "Stella" },
  { id: "codex_local", name: "Codex" },
  { id: "claude_code_local", name: "Claude Code" },
] as const;

const CODEX_LOCAL_CONCURRENCY_OPTIONS = [1, 2, 3] as const;

const LLM_PROVIDERS = [
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { key: "openai", label: "OpenAI", placeholder: "sk-..." },
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
];

// ---------------------------------------------------------------------------
// Basic Tab
// ---------------------------------------------------------------------------

function BasicTab({ onSignOut }: {
  onSignOut?: () => void;
}) {
  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Storage</div>
            <div className="settings-row-sublabel">
              Local only. Conversations stay on this device.
            </div>
            <div className="settings-row-sublabel">
              Cloud sync and connected mode are not available in the app right now.
            </div>
          </div>
        </div>
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
            <div className="settings-row-sublabel">
              Erase all conversations and memories.
            </div>
            <div className="settings-row-sublabel">
              This action is not available in the desktop app yet.
            </div>
          </div>
          <div className="settings-row-control">
            <button className="settings-btn settings-btn--danger" disabled>
              Delete
            </button>
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
            <button className="settings-btn settings-btn--danger" disabled>
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
    | "claude_code_local"
    | undefined;
  const setGeneralAgentEngine = useMutation(api.data.preferences.setGeneralAgentEngine);
  const codexLocalMaxConcurrency = useQuery(api.data.preferences.getCodexLocalMaxConcurrency) as number | undefined;
  const setCodexLocalMaxConcurrency = useMutation(api.data.preferences.setCodexLocalMaxConcurrency);
  const { groups } = useModelCatalog();
  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const group of groups) {
      for (const model of group.models) {
        next.set(model.id, model.name);
      }
    }
    return next;
  }, [groups]);

  const serverOverrides = useMemo<Record<string, string>>(() => {
    if (!overridesJson) {
      return {};
    }

    try {
      return normalizeModelOverrides(JSON.parse(overridesJson) as Record<string, string>);
    } catch {
      return {};
    }
  }, [overridesJson]);
  const [localOverrides, setLocalOverrides] = useState<Record<string, string | null>>({});
  const [localGeneralAgentEngine, setLocalGeneralAgentEngine] = useState<
    "default" | "codex_local" | "claude_code_local" | null
  >(null);
  const [localCodexLocalMaxConcurrency, setLocalCodexLocalMaxConcurrency] = useState<number | null>(null);

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
    (localGeneralAgentEngine !== null && localGeneralAgentEngine !== generalAgentEngine
      ? localGeneralAgentEngine
      : null) ?? generalAgentEngine ?? "default";
  const effectiveCodexLocalMaxConcurrency =
    (localCodexLocalMaxConcurrency !== null
    && localCodexLocalMaxConcurrency !== codexLocalMaxConcurrency
      ? localCodexLocalMaxConcurrency
      : null) ?? codexLocalMaxConcurrency ?? 3;

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
      const engine =
        value === "codex_local"
          ? "codex_local"
          : value === "claude_code_local"
            ? "claude_code_local"
            : "default";
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
              Local engine modes require the corresponding CLI (<code>codex</code> or <code>claude</code>).
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
                <option value="">{getDefaultModelOptionLabel(agent.key, modelNamesById)}</option>
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
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [llmCredentials, setLlmCredentials] = useState<LocalLlmCredentialSummary[]>([]);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [removingProvider, setRemovingProvider] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    if (!window.electronAPI?.system.listLlmCredentials) {
      setLlmCredentials([]);
      return;
    }

    const nextCredentials = await window.electronAPI.system.listLlmCredentials();
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
            error instanceof Error ? error.message : "Failed to load local API keys.",
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
    llmCredentials.find((credential) =>
      credential.provider === providerKey && credential.status === "active");

  const handleSave = useCallback(
    async (providerKey: string, label: string) => {
      if (!keyInput.trim()) return;
      if (!window.electronAPI?.system.saveLlmCredential) {
        setCredentialsError("Local API key storage is unavailable in this window.");
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
          const next = prev.filter((entry) => entry.provider !== saved.provider);
          next.push(saved);
          return next.sort((a, b) => a.label.localeCompare(b.label));
        });
        setKeyInput("");
        setEditingProvider(null);
      } catch (error) {
        setCredentialsError(
          error instanceof Error ? error.message : "Failed to save local API key.",
        );
      } finally {
        setIsSavingKey(false);
      }
    },
    [keyInput],
  );

  const handleRemove = useCallback(
    async (providerKey: string) => {
      if (!window.electronAPI?.system.deleteLlmCredential) {
        setCredentialsError("Local API key storage is unavailable in this window.");
        return;
      }
      setCredentialsError(null);
      setRemovingProvider(providerKey);
      try {
        await window.electronAPI.system.deleteLlmCredential(providerKey);
        setLlmCredentials((prev) => prev.filter((entry) => entry.provider !== providerKey));
      } catch (error) {
        setCredentialsError(
          error instanceof Error ? error.message : "Failed to remove local API key.",
        );
      } finally {
        setRemovingProvider(null);
      }
    },
    [],
  );

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">API Keys</h3>
      <p className="settings-card-desc">
        Keys stay on this device. If Stella has a matching local key it calls that provider
        directly. Otherwise it uses the managed Stella route.
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
                    disabled={isSavingKey}
                  >
                    {isSavingKey ? "Saving..." : "Save"}
                  </button>
                  <button
                    className="settings-btn"
                    onClick={() => {
                      setEditingProvider(null);
                      setKeyInput("");
                    }}
                    disabled={isSavingKey}
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
                      setCredentialsError(null);
                    }}
                    disabled={isSavingKey || Boolean(removingProvider)}
                  >
                    {credential ? "Update Key" : "Add Key"}
                  </button>
                  {credential && (
                    <button
                      className="settings-btn settings-btn--danger"
                      onClick={() => handleRemove(provider.key)}
                      disabled={isRemoving || isSavingKey}
                    >
                      {isRemoving ? "Removing..." : "Remove"}
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



