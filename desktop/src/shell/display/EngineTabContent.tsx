import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./engine-tab.css";

type AgentRuntimeEngine =
  | "default"
  | "claude_code_local"
  | "cursor_sdk"
  | "codex_cli";

type LocalModelPreferences = {
  agentRuntimeEngine: AgentRuntimeEngine;
  cursorModel: string;
  codexModel: string;
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
  hint: string;
}> = [
  { id: "default", label: "Stella", hint: "Built-in runtime" },
  { id: "cursor_sdk", label: "Cursor", hint: "Bring your API key" },
  { id: "codex_cli", label: "Codex", hint: "Uses your Codex CLI" },
  { id: "claude_code_local", label: "Claude Code", hint: "Uses your Claude CLI" },
];

const DEFAULT_CURSOR_MODEL = "composer-latest";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const PREFS_EVENT = "stella:local-model-preferences-changed";
const NOTICE_TTL_MS = 2400;

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

const prefsEqual = (
  a: LocalModelPreferences,
  b: LocalModelPreferences,
): boolean =>
  a.agentRuntimeEngine === b.agentRuntimeEngine &&
  a.cursorModel === b.cursorModel &&
  a.codexModel === b.codexModel;

export function EngineTabContent() {
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [hasCursorApiKey, setHasCursorApiKey] = useState(false);
  const [cursorModels, setCursorModels] = useState<CursorModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState(DEFAULT_CURSOR_MODEL);
  const [codexModelDraft, setCodexModelDraft] = useState(DEFAULT_CODEX_MODEL);
  const [manualModelOpen, setManualModelOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"engine" | "key" | "model" | null>(
    null,
  );
  const [status, setStatus] = useState<
    { kind: "notice" | "error"; text: string } | null
  >(null);
  const selfDispatchRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);

  const selectedEngine = preferences?.agentRuntimeEngine ?? "default";
  const cursorReady = selectedEngine === "cursor_sdk" && hasCursorApiKey;
  const modelChanged =
    modelDraft.trim() !== (preferences?.cursorModel ?? DEFAULT_CURSOR_MODEL);
  const codexModelChanged =
    codexModelDraft.trim() !==
    (preferences?.codexModel ?? DEFAULT_CODEX_MODEL);
  const selectedModelId = preferences?.cursorModel ?? DEFAULT_CURSOR_MODEL;
  const inputsDisabled = loading || Boolean(saving);

  const showNotice = useCallback((text: string) => {
    setStatus({ kind: "notice", text });
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setStatus((current) =>
        current?.kind === "notice" && current.text === text ? null : current,
      );
    }, NOTICE_TTL_MS);
  }, []);

  const showError = useCallback((text: string) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setStatus({ kind: "error", text });
  }, []);

  const clearStatus = useCallback(() => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setStatus(null);
  }, []);

  const applySavedPrefs = useCallback(
    (
      saved: LocalModelPreferences | null | undefined,
      { resetDrafts }: { resetDrafts: boolean },
    ) => {
      if (!saved) return;
      const next: LocalModelPreferences = {
        agentRuntimeEngine: saved.agentRuntimeEngine,
        cursorModel: saved.cursorModel || DEFAULT_CURSOR_MODEL,
        codexModel: saved.codexModel || DEFAULT_CODEX_MODEL,
      };
      setPreferences((current) =>
        current && prefsEqual(current, next) ? current : next,
      );
      if (resetDrafts) {
        setModelDraft((current) =>
          current === next.cursorModel ? current : next.cursorModel,
        );
        setCodexModelDraft((current) =>
          current === next.codexModel ? current : next.codexModel,
        );
      }
    },
    [],
  );

  const notifyPrefsChanged = useCallback(() => {
    selfDispatchRef.current = true;
    window.dispatchEvent(new CustomEvent(PREFS_EVENT));
  }, []);

  const loadCursorModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const result = await window.electronAPI?.system?.listCursorModels?.();
      setCursorModels(result?.models ?? []);
    } catch (caught) {
      // Keep any previously-loaded models in view; surface failure inline.
      showError(errorText(caught, "Cursor models did not load."));
    } finally {
      setModelsLoading(false);
    }
  }, [showError]);

  const cursorModelsLoadedRef = useRef(false);
  useEffect(() => {
    if (cursorModels.length > 0) cursorModelsLoadedRef.current = true;
  }, [cursorModels.length]);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      try {
        const [prefs, keyStatus] = await Promise.all([
          window.electronAPI?.system?.getLocalModelPreferences?.(),
          window.electronAPI?.system?.getCursorApiKeyStatus?.(),
        ]);
        applySavedPrefs(prefs, { resetDrafts: !options?.silent });
        const nextHasKey = Boolean(keyStatus?.hasApiKey);
        setHasCursorApiKey(nextHasKey);
        if (nextHasKey && !cursorModelsLoadedRef.current) {
          void loadCursorModels();
        } else if (!nextHasKey) {
          setCursorModels([]);
          cursorModelsLoadedRef.current = false;
        }
      } catch (caught) {
        showError(errorText(caught, "Engine settings did not load."));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [applySavedPrefs, loadCursorModels, showError],
  );

  useEffect(() => {
    void load();
    const onExternalChange = () => {
      if (selfDispatchRef.current) {
        selfDispatchRef.current = false;
        return;
      }
      void load({ silent: true });
    };
    window.addEventListener(PREFS_EVENT, onExternalChange);
    return () => {
      window.removeEventListener(PREFS_EVENT, onExternalChange);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
    // `load` is stable for the lifecycle of the panel; avoid re-subscribing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveEngine = useCallback(
    async (engine: AgentRuntimeEngine) => {
      if (!preferences || saving || engine === preferences.agentRuntimeEngine) {
        return;
      }
      const previous = preferences;
      setPreferences({ ...preferences, agentRuntimeEngine: engine });
      setSaving("engine");
      clearStatus();
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            agentRuntimeEngine: engine,
          });
        applySavedPrefs(saved, { resetDrafts: false });
        notifyPrefsChanged();
        showNotice(
          `${ENGINE_OPTIONS.find((opt) => opt.id === engine)?.label ?? "Engine"} selected`,
        );
      } catch (caught) {
        setPreferences(previous);
        showError(errorText(caught, "Engine was not updated."));
      } finally {
        setSaving(null);
      }
    },
    [
      applySavedPrefs,
      clearStatus,
      notifyPrefsChanged,
      preferences,
      saving,
      showError,
      showNotice,
    ],
  );

  const saveApiKey = useCallback(async () => {
    if (saving) return;
    setSaving("key");
    clearStatus();
    try {
      const saved = await window.electronAPI?.system?.setCursorApiKey?.({
        apiKey: apiKeyDraft,
      });
      const nextHasKey = Boolean(saved?.hasApiKey);
      setHasCursorApiKey(nextHasKey);
      setApiKeyDraft("");
      showNotice(nextHasKey ? "Cursor key saved" : "Cursor key removed");
      if (nextHasKey) {
        cursorModelsLoadedRef.current = false;
        void loadCursorModels();
      } else {
        setCursorModels([]);
        cursorModelsLoadedRef.current = false;
      }
    } catch (caught) {
      showError(errorText(caught, "Cursor key was not saved."));
    } finally {
      setSaving(null);
    }
  }, [apiKeyDraft, clearStatus, loadCursorModels, saving, showError, showNotice]);

  const persistCursorModel = useCallback(
    async (nextModel: string) => {
      if (!preferences) return;
      if (nextModel === preferences.cursorModel) return;
      setSaving("model");
      clearStatus();
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            cursorModel: nextModel,
          });
        applySavedPrefs(saved, { resetDrafts: true });
        notifyPrefsChanged();
        showNotice("Cursor model saved");
      } catch (caught) {
        showError(errorText(caught, "Cursor model was not saved."));
      } finally {
        setSaving(null);
      }
    },
    [
      applySavedPrefs,
      clearStatus,
      notifyPrefsChanged,
      preferences,
      showError,
      showNotice,
    ],
  );

  const saveModel = useCallback(() => {
    if (saving) return;
    void persistCursorModel(modelDraft.trim() || DEFAULT_CURSOR_MODEL);
  }, [modelDraft, persistCursorModel, saving]);

  const selectModel = useCallback(
    (modelId: string) => {
      if (saving || !preferences) return;
      setModelDraft(modelId);
      void persistCursorModel(modelId);
    },
    [persistCursorModel, preferences, saving],
  );

  const saveCodexModel = useCallback(async () => {
    if (!preferences || saving) return;
    const nextModel = codexModelDraft.trim() || DEFAULT_CODEX_MODEL;
    if (nextModel === preferences.codexModel) return;
    setSaving("model");
    clearStatus();
    try {
      const saved =
        await window.electronAPI?.system?.setLocalModelPreferences?.({
          codexModel: nextModel,
        });
      applySavedPrefs(saved, { resetDrafts: true });
      notifyPrefsChanged();
      showNotice("Codex model saved");
    } catch (caught) {
      showError(errorText(caught, "Codex model was not saved."));
    } finally {
      setSaving(null);
    }
  }, [
    applySavedPrefs,
    clearStatus,
    codexModelDraft,
    notifyPrefsChanged,
    preferences,
    saving,
    showError,
    showNotice,
  ]);

  const subtitle = useMemo(() => {
    if (loading) return "Loading…";
    if (selectedEngine === "cursor_sdk")
      return cursorReady ? "Cursor ready" : "Add a Cursor key to continue";
    if (selectedEngine === "codex_cli") return "Runs your local Codex CLI";
    if (selectedEngine === "claude_code_local")
      return "Runs your local Claude Code CLI";
    return "Stella's built-in runtime";
  }, [cursorReady, loading, selectedEngine]);

  return (
    <div className="display-sidebar__rich display-sidebar__rich--engine">
      <section className="engine-tab" aria-label="Engine settings">
        <header className="engine-tab__header">
          <h3 className="engine-tab__title">Engine</h3>
          <p className="engine-tab__subtitle">{subtitle}</p>
        </header>

        <div
          className="engine-tab__status-slot"
          role="status"
          aria-live="polite"
          data-kind={status?.kind ?? "idle"}
        >
          {status ? <span>{status.text}</span> : null}
        </div>

        <div
          className="engine-tab__engine-list"
          role="radiogroup"
          aria-label="Agent runtime"
        >
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
                disabled={inputsDisabled}
                onClick={() => void saveEngine(option.id)}
              >
                <span className="engine-tab__engine-label">{option.label}</span>
                <small className="engine-tab__engine-hint">{option.hint}</small>
              </button>
            );
          })}
        </div>

        <div className="engine-tab__config-slot">
          {selectedEngine === "cursor_sdk" ? (
            <div className="engine-tab__config" key="cursor_sdk">
              <div className="engine-tab__row">
                <label
                  className="engine-tab__label"
                  htmlFor="engine-cursor-key"
                >
                  API key
                </label>
                <div className="engine-tab__field-row">
                  <input
                    id="engine-cursor-key"
                    type="password"
                    value={apiKeyDraft}
                    placeholder={
                      hasCursorApiKey
                        ? "Replace saved key"
                        : "Paste Cursor API key"
                    }
                    className="engine-tab__input"
                    autoComplete="off"
                    disabled={inputsDisabled}
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="pill-btn pill-btn--primary"
                    disabled={
                      loading ||
                      saving === "key" ||
                      (!apiKeyDraft.trim() && !hasCursorApiKey)
                    }
                    onClick={() => void saveApiKey()}
                  >
                    {apiKeyDraft.trim()
                      ? "Save"
                      : hasCursorApiKey
                        ? "Clear"
                        : "Save"}
                  </button>
                </div>
              </div>

              <div className="engine-tab__row">
                <div className="engine-tab__label-row">
                  <span className="engine-tab__label">Model</span>
                  {hasCursorApiKey && cursorModels.length > 0 ? (
                    <button
                      type="button"
                      className="engine-tab__link"
                      disabled={modelsLoading}
                      onClick={() => void loadCursorModels()}
                    >
                      {modelsLoading ? "Refreshing…" : "Refresh"}
                    </button>
                  ) : null}
                </div>

                <div
                  className="engine-tab__model-list"
                  role="radiogroup"
                  aria-busy={modelsLoading || undefined}
                  data-empty={cursorModels.length === 0 || undefined}
                >
                  {cursorModels.length > 0 ? (
                    cursorModels.map((model) => {
                      const selected =
                        model.id === selectedModelId ||
                        model.aliases?.includes(selectedModelId);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="radio"
                          aria-checked={Boolean(selected)}
                          data-selected={selected || undefined}
                          className="engine-tab__model-option"
                          disabled={inputsDisabled}
                          onClick={() => selectModel(model.id)}
                        >
                          <span>{model.displayName || model.id}</span>
                          <small>{model.aliases?.[0] ?? model.id}</small>
                        </button>
                      );
                    })
                  ) : (
                    <p className="engine-tab__model-empty">
                      {hasCursorApiKey
                        ? modelsLoading
                          ? "Loading Cursor models…"
                          : "No models available — enter one manually below."
                        : "Save a Cursor key to load model choices."}
                    </p>
                  )}
                </div>

                {cursorModels.length > 0 ? (
                  <button
                    type="button"
                    className="engine-tab__link"
                    onClick={() => setManualModelOpen((value) => !value)}
                  >
                    {manualModelOpen ? "Hide model id" : "Enter model id"}
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
                      disabled={inputsDisabled}
                      onChange={(event) => setModelDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="pill-btn pill-btn--primary"
                      disabled={
                        loading || saving === "model" || !modelChanged
                      }
                      onClick={saveModel}
                    >
                      Save
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : selectedEngine === "codex_cli" ? (
            <div className="engine-tab__config" key="codex_cli">
              <div className="engine-tab__row">
                <label
                  className="engine-tab__label"
                  htmlFor="engine-codex-model"
                >
                  Model
                </label>
                <div className="engine-tab__field-row">
                  <input
                    id="engine-codex-model"
                    type="text"
                    value={codexModelDraft}
                    placeholder={DEFAULT_CODEX_MODEL}
                    className="engine-tab__input"
                    spellCheck={false}
                    disabled={inputsDisabled}
                    onChange={(event) =>
                      setCodexModelDraft(event.target.value)
                    }
                  />
                  <button
                    type="button"
                    className="pill-btn pill-btn--primary"
                    disabled={
                      loading || saving === "model" || !codexModelChanged
                    }
                    onClick={() => void saveCodexModel()}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              className="engine-tab__config engine-tab__config--idle"
              key="idle"
            />
          )}
        </div>
      </section>
    </div>
  );
}
