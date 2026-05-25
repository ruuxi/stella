import { useCallback, useEffect, useMemo, useState } from "react";
import "./engine-tab.css";

type AgentRuntimeEngine = "default" | "claude_code_local" | "cursor_sdk";

type LocalModelPreferences = {
  agentRuntimeEngine: AgentRuntimeEngine;
  cursorModel: string;
};

type CursorModelOption = {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
};

const ENGINE_OPTIONS: ReadonlyArray<{
  id: AgentRuntimeEngine;
  label: string;
  detail: string;
}> = [
  {
    id: "default",
    label: "Stella",
    detail: "Use Stella's built-in agent runner.",
  },
  {
    id: "cursor_sdk",
    label: "Cursor",
    detail: "Use Cursor for spawned general agents.",
  },
  {
    id: "claude_code_local",
    label: "Claude Code",
    detail: "Use the local Claude Code runner.",
  },
];

const DEFAULT_CURSOR_MODEL = "composer-latest";

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

export function EngineTabContent() {
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [hasCursorApiKey, setHasCursorApiKey] = useState(false);
  const [cursorModels, setCursorModels] = useState<CursorModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState(DEFAULT_CURSOR_MODEL);
  const [manualModelOpen, setManualModelOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"engine" | "key" | "model" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedEngine = preferences?.agentRuntimeEngine ?? "default";
  const cursorReady = selectedEngine === "cursor_sdk" && hasCursorApiKey;
  const modelChanged =
    modelDraft.trim() !== (preferences?.cursorModel ?? DEFAULT_CURSOR_MODEL);
  const selectedModelId = preferences?.cursorModel ?? DEFAULT_CURSOR_MODEL;

  const loadCursorModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const result = await window.electronAPI?.system?.listCursorModels?.();
      setCursorModels(result?.models ?? []);
    } catch (caught) {
      setCursorModels([]);
      setError(errorText(caught, "Cursor models did not load."));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [prefs, keyStatus] = await Promise.all([
        window.electronAPI?.system?.getLocalModelPreferences?.(),
        window.electronAPI?.system?.getCursorApiKeyStatus?.(),
      ]);
      if (prefs) {
        setPreferences({
          agentRuntimeEngine: prefs.agentRuntimeEngine,
          cursorModel: prefs.cursorModel || DEFAULT_CURSOR_MODEL,
        });
        setModelDraft(prefs.cursorModel || DEFAULT_CURSOR_MODEL);
      }
      const nextHasKey = Boolean(keyStatus?.hasApiKey);
      setHasCursorApiKey(nextHasKey);
      if (nextHasKey) {
        void loadCursorModels();
      } else {
        setCursorModels([]);
      }
    } catch (caught) {
      setError(errorText(caught, "Engine settings did not load."));
    } finally {
      setLoading(false);
    }
  }, [loadCursorModels]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveEngine = useCallback(
    async (engine: AgentRuntimeEngine) => {
      if (!preferences || saving || engine === preferences.agentRuntimeEngine) {
        return;
      }
      const previous = preferences;
      setPreferences({ ...preferences, agentRuntimeEngine: engine });
      setSaving("engine");
      setNotice(null);
      setError(null);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            agentRuntimeEngine: engine,
          });
        if (saved) {
          setPreferences({
            agentRuntimeEngine: saved.agentRuntimeEngine,
            cursorModel: saved.cursorModel || DEFAULT_CURSOR_MODEL,
          });
        }
        setNotice(`${ENGINE_OPTIONS.find((opt) => opt.id === engine)?.label ?? "Engine"} selected.`);
      } catch (caught) {
        setPreferences(previous);
        setError(errorText(caught, "Engine was not updated."));
      } finally {
        setSaving(null);
      }
    },
    [preferences, saving],
  );

  const saveApiKey = useCallback(async () => {
    if (saving) return;
    setSaving("key");
    setNotice(null);
    setError(null);
    try {
      const saved = await window.electronAPI?.system?.setCursorApiKey?.({
        apiKey: apiKeyDraft,
      });
      setHasCursorApiKey(Boolean(saved?.hasApiKey));
      setApiKeyDraft("");
      setNotice(saved?.hasApiKey ? "Cursor key saved." : "Cursor key removed.");
      if (saved?.hasApiKey) {
        void loadCursorModels();
      } else {
        setCursorModels([]);
      }
    } catch (caught) {
      setError(errorText(caught, "Cursor key was not saved."));
    } finally {
      setSaving(null);
    }
  }, [apiKeyDraft, loadCursorModels, saving]);

  const saveModel = useCallback(async () => {
    if (!preferences || saving) return;
    const nextModel = modelDraft.trim() || DEFAULT_CURSOR_MODEL;
    setSaving("model");
    setNotice(null);
    setError(null);
    try {
      const saved =
        await window.electronAPI?.system?.setLocalModelPreferences?.({
          cursorModel: nextModel,
        });
      if (saved) {
        setPreferences({
          agentRuntimeEngine: saved.agentRuntimeEngine,
          cursorModel: saved.cursorModel || DEFAULT_CURSOR_MODEL,
        });
        setModelDraft(saved.cursorModel || DEFAULT_CURSOR_MODEL);
      }
      setNotice("Cursor model saved.");
    } catch (caught) {
      setError(errorText(caught, "Cursor model was not saved."));
    } finally {
      setSaving(null);
    }
  }, [modelDraft, preferences, saving]);

  const selectModel = useCallback(
    async (modelId: string) => {
      if (!preferences || saving || modelId === preferences.cursorModel) return;
      setModelDraft(modelId);
      setSaving("model");
      setNotice(null);
      setError(null);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            cursorModel: modelId,
          });
        if (saved) {
          setPreferences({
            agentRuntimeEngine: saved.agentRuntimeEngine,
            cursorModel: saved.cursorModel || DEFAULT_CURSOR_MODEL,
          });
          setModelDraft(saved.cursorModel || DEFAULT_CURSOR_MODEL);
        }
        setNotice("Cursor model saved.");
      } catch (caught) {
        setError(errorText(caught, "Cursor model was not saved."));
      } finally {
        setSaving(null);
      }
    },
    [preferences, saving],
  );

  const statusLabel = useMemo(() => {
    if (loading) return "Loading";
    if (cursorReady) return "Cursor ready";
    if (selectedEngine === "cursor_sdk") return "Cursor needs a key";
    return "Cursor available";
  }, [cursorReady, loading, selectedEngine]);

  return (
    <div className="display-sidebar__rich display-sidebar__rich--engine">
      <section className="engine-tab" aria-label="Engine settings">
        <header className="engine-tab__header">
          <div>
            <p className="engine-tab__eyebrow">Engine</p>
            <h2>Agent runtime</h2>
          </div>
          <span className="engine-tab__status">{statusLabel}</span>
        </header>

        {error ? (
          <p className="engine-tab__message engine-tab__message--error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="engine-tab__message">{notice}</p> : null}

        <div className="engine-tab__section">
          <div className="engine-tab__section-copy">
            <h3>Run agents with</h3>
          </div>
          <div className="engine-tab__engine-list" role="radiogroup">
            {ENGINE_OPTIONS.map((option) => {
              const selected = option.id === selectedEngine;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-selected={selected || undefined}
                  className="engine-tab__engine-option"
                  disabled={loading || Boolean(saving)}
                  onClick={() => void saveEngine(option.id)}
                >
                  <span>{option.label}</span>
                  <small>{option.detail}</small>
                </button>
              );
            })}
          </div>
        </div>

        <div className="engine-tab__section">
          <div className="engine-tab__section-copy">
            <h3>Cursor API key</h3>
            <p>{hasCursorApiKey ? "A key is saved locally." : "No key saved."}</p>
          </div>
          <div className="engine-tab__field-row">
            <input
              type="password"
              value={apiKeyDraft}
              placeholder={hasCursorApiKey ? "Replace saved key" : "Paste API key"}
              className="engine-tab__input"
              autoComplete="off"
              disabled={loading || Boolean(saving)}
              onChange={(event) => setApiKeyDraft(event.target.value)}
            />
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              disabled={loading || saving === "key"}
              onClick={() => void saveApiKey()}
            >
              {apiKeyDraft.trim() ? "Save" : "Clear"}
            </button>
          </div>
        </div>

        <div className="engine-tab__section">
          <div className="engine-tab__section-copy">
            <h3>Cursor model</h3>
            <p>
              {hasCursorApiKey
                ? modelsLoading
                  ? "Loading Cursor models."
                  : cursorModels.length > 0
                    ? "Choose from Cursor's available models."
                    : "Use a model id manually."
                : "Save a Cursor key to load model choices."}
            </p>
          </div>
          {cursorModels.length > 0 ? (
            <div className="engine-tab__model-list" role="radiogroup">
              {cursorModels.map((model) => {
                const selected =
                  model.id === selectedModelId ||
                  model.aliases?.includes(selectedModelId);
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected || undefined}
                    className="engine-tab__model-option"
                    disabled={loading || Boolean(saving)}
                    onClick={() => void selectModel(model.id)}
                  >
                    <span>{model.displayName || model.id}</span>
                    <small>{model.aliases?.[0] ?? model.id}</small>
                  </button>
                );
              })}
            </div>
          ) : null}
          {cursorModels.length > 0 ? (
            <button
              type="button"
              className="engine-tab__manual-toggle"
              onClick={() => setManualModelOpen((value) => !value)}
            >
              {manualModelOpen ? "Hide model id" : "Use model id"}
            </button>
          ) : null}
          {manualModelOpen || cursorModels.length === 0 ? (
            <div className="engine-tab__field-row">
              <input
                type="text"
                value={modelDraft}
                placeholder={DEFAULT_CURSOR_MODEL}
                className="engine-tab__input"
                spellCheck={false}
                disabled={loading || Boolean(saving)}
                onChange={(event) => setModelDraft(event.target.value)}
              />
              <button
                type="button"
                className="pill-btn pill-btn--primary"
                disabled={loading || saving === "model" || !modelChanged}
                onClick={() => void saveModel()}
              >
                Save
              </button>
            </div>
          ) : null}
          {hasCursorApiKey ? (
            <button
              type="button"
              className="engine-tab__manual-toggle"
              disabled={modelsLoading}
              onClick={() => void loadCursorModels()}
            >
              Refresh models
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
