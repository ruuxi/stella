import { useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useModelCatalog } from "../../hooks/use-model-catalog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/components/dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsTab = "basic" | "models";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenRuntimeMode?: () => void;
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

const LLM_PROVIDERS = [
  { key: "llm:anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { key: "llm:openai", label: "OpenAI", placeholder: "sk-..." },
  { key: "llm:google", label: "Google", placeholder: "AIza..." },
  { key: "llm:openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
  { key: "llm:gateway", label: "Vercel AI Gateway", placeholder: "..." },
] as const;

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "basic", label: "Basic" },
  { key: "models", label: "Models" },
];

// ---------------------------------------------------------------------------
// Basic Tab
// ---------------------------------------------------------------------------

function BasicTab({ onOpenRuntimeMode, onSignOut }: {
  onOpenRuntimeMode?: () => void;
  onSignOut?: () => void;
}) {
  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Runtime Mode</div>
            <div className="settings-row-sublabel">Configure local or 24/7 cloud execution</div>
          </div>
          <div className="settings-row-control">
            <button className="settings-btn" onClick={onOpenRuntimeMode}>
              Configure
            </button>
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
  const { groups } = useModelCatalog();

  const overrides: Record<string, string> = overridesJson ? JSON.parse(overridesJson) : {};
  const hasAnyOverride = Object.keys(overrides).length > 0;

  const handleChange = useCallback(
    (agentType: string, value: string) => {
      if (value === "") {
        clearOverride({ agentType });
      } else {
        setOverride({ agentType, model: value });
      }
    },
    [setOverride, clearOverride],
  );

  const handleResetAll = useCallback(() => {
    for (const key of Object.keys(overrides)) {
      clearOverride({ agentType: key });
    }
  }, [overrides, clearOverride]);

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">Model Configuration</h3>
        {hasAnyOverride && (
          <button
            className="settings-btn settings-btn--reset-all"
            onClick={handleResetAll}
          >
            Reset All
          </button>
        )}
      </div>
      <p className="settings-card-desc">Override the default model for each agent type.</p>
      {CONFIGURABLE_AGENTS.map((agent) => {
        const current = overrides[agent.key] ?? "";
        const defaultModel = AGENT_DEFAULTS[agent.key] ?? "";
        return (
          <div key={agent.key} className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">{agent.label}</div>
              <div className="settings-row-sublabel">{agent.desc}</div>
            </div>
            <div className="settings-row-control">
              <select
                className="settings-model-select"
                value={current}
                onChange={(e) => handleChange(agent.key, e.target.value)}
              >
                <option value="">{defaultModel || "Default"}</option>
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
              {current && (
                <button
                  className="settings-btn"
                  onClick={() => handleChange(agent.key, "")}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
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
// SettingsDialog
// ---------------------------------------------------------------------------

export const SettingsDialog = ({ open, onOpenChange, onOpenRuntimeMode, onSignOut }: SettingsDialogProps) => {
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
            <div className="settings-panel">
              {activeTab === "basic" ? (
                <BasicTab onOpenRuntimeMode={onOpenRuntimeMode} onSignOut={onSignOut} />
              ) : (
                <ModelsTab />
              )}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

export default SettingsDialog;
