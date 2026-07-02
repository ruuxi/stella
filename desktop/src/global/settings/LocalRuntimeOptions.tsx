import { useCallback, useEffect, useMemo, useState } from "react";
import { Select, type SelectOption } from "@/ui/select";
import { requestCodexEngineNotice } from "./CodexEngineNoticeDialog";
import { getSettingsErrorMessage } from "./tabs/shared";
import "./LocalRuntimeOptions.css";

const PREFS_CHANGED_EVENT = "stella:local-model-preferences-changed";

const ENGINE_OPTIONS = [
  { id: "default", label: "Stella" },
  { id: "codex_cli", label: "Codex" },
  { id: "claude_code_local", label: "Claude Code" },
] as const;

type EngineId = (typeof ENGINE_OPTIONS)[number]["id"];

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  reasoningEfforts: Record<
    string,
    "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >;
  agentRuntimeEngine: EngineId;
  codexModel: string;
  claudeCodeModel: string;
};

type EngineModelOption = {
  id: string;
  label: string;
  description?: string;
};

const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CLAUDE_CODE_MODEL = "default";

/**
 * Engine selector for the local agent runtime. Lives inside the expanded
 * section of `AgentModelPicker` so it shows up in both the sidebar popover
 * and the Settings page model picker without a parallel "Agents" card.
 */
export function LocalRuntimeOptions() {
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [codexModels, setCodexModels] = useState<EngineModelOption[] | null>(
    null,
  );
  const [claudeCodeModels, setClaudeCodeModels] = useState<
    EngineModelOption[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled) {
          setPreferences(next ?? null);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            getSettingsErrorMessage(caught, "Failed to load runtime settings."),
          );
        }
      }
    };
    void load();
    // Reload when preferences change elsewhere (e.g. the root-mounted Codex
    // notice dialog applies the engine switch after this popover has lost
    // focus) so the highlighted engine stays in sync.
    const onExternalChange = () => void load();
    window.addEventListener(PREFS_CHANGED_EVENT, onExternalChange);
    return () => {
      cancelled = true;
      window.removeEventListener(PREFS_CHANGED_EVENT, onExternalChange);
    };
  }, []);

  const ready = preferences !== null;
  const engine: EngineId = preferences?.agentRuntimeEngine ?? "default";

  // Fetch the engine's own model catalog the first time it's selected so
  // the Model select is populated when Codex / Claude Code is active.
  useEffect(() => {
    let cancelled = false;
    if (engine === "codex_cli" && codexModels === null) {
      void window.electronAPI?.system
        ?.listCodexModels?.()
        .then((result) => {
          if (cancelled) return;
          setCodexModels(
            (result?.models ?? [])
              .filter((model) => !model.hidden)
              .map((model) => ({
                id: model.id,
                label: model.displayName || model.id,
                description: model.description || undefined,
              })),
          );
        })
        .catch(() => {
          if (!cancelled) setCodexModels([]);
        });
    }
    if (engine === "claude_code_local" && claudeCodeModels === null) {
      void window.electronAPI?.system
        ?.listClaudeCodeModels?.()
        .then((result) => {
          if (cancelled) return;
          setClaudeCodeModels(
            (result?.models ?? []).map((model) => ({
              id: model.id,
              label: model.displayName || model.id,
              description: model.description,
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setClaudeCodeModels([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [claudeCodeModels, codexModels, engine]);

  const engineModels = engine === "codex_cli" ? codexModels : claudeCodeModels;
  const engineModelValue =
    engine === "codex_cli"
      ? preferences?.codexModel || DEFAULT_CODEX_MODEL
      : preferences?.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL;

  const engineModelOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = (engineModels ?? []).map((model) => ({
      value: model.id,
      label: model.label,
    }));
    // Keep an out-of-catalog saved value (e.g. hidden or hand-set model)
    // selectable instead of rendering an empty trigger.
    if (
      engineModelValue &&
      !options.some((option) => option.value === engineModelValue)
    ) {
      options.push({ value: engineModelValue, label: engineModelValue });
    }
    return options;
  }, [engineModels, engineModelValue]);

  const engineModelDescription = engineModels?.find(
    (model) => model.id === engineModelValue,
  )?.description;

  const handleEngineModelChange = useCallback(
    async (nextModel: string) => {
      if (saving || !preferences || nextModel === engineModelValue) return;
      const previous = preferences;
      const patch =
        engine === "codex_cli"
          ? { codexModel: nextModel }
          : { claudeCodeModel: nextModel };
      setSaving(true);
      setPreferences({ ...preferences, ...patch });
      setError(null);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
        if (saved) setPreferences(saved);
        window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT));
      } catch (caught) {
        setPreferences(previous);
        setError(
          getSettingsErrorMessage(caught, "Failed to update the engine model."),
        );
      } finally {
        setSaving(false);
      }
    },
    [engine, engineModelValue, preferences, saving],
  );

  const commitEngineChange = useCallback(
    async (next: EngineId) => {
      if (saving || !preferences || preferences.agentRuntimeEngine === next)
        return;
      const previous = preferences;
      setSaving(true);
      setPreferences({ ...preferences, agentRuntimeEngine: next });
      setError(null);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            agentRuntimeEngine: next,
          });
        if (saved) setPreferences(saved);
      } catch (caught) {
        setPreferences(previous);
        setError(
          getSettingsErrorMessage(
            caught,
            "Failed to update the agent runtime.",
          ),
        );
      } finally {
        setSaving(false);
      }
    },
    [preferences, saving],
  );

  const handleEngineChange = useCallback(
    async (next: EngineId) => {
      if (saving || !preferences || preferences.agentRuntimeEngine === next)
        return;
      // Codex only runs the agents Stella spawns, not Stella herself. Hand off
      // to the root-mounted notice dialog, which explains that and applies the
      // switch once the user acknowledges it.
      if (next === "codex_cli") {
        requestCodexEngineNotice();
        return;
      }
      await commitEngineChange(next);
    },
    [commitEngineChange, preferences, saving],
  );

  return (
    <div className="local-runtime-options">
      <div className="local-runtime-options-title">Agents</div>
      {error ? (
        <p className="local-runtime-options-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="local-runtime-options-row">
        <div className="local-runtime-options-row-info">
          <div className="local-runtime-options-row-label">Engine</div>
          <div className="local-runtime-options-row-sublabel">
            Choose the engine for spawned agents.
          </div>
        </div>
        <div
          className="local-runtime-options-toggle"
          role="tablist"
          aria-label="Engine"
        >
          {ENGINE_OPTIONS.map((option) => {
            const isActive = ready && option.id === engine;
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className="local-runtime-options-toggle-btn"
                data-active={isActive || undefined}
                onClick={() => void handleEngineChange(option.id)}
                disabled={!ready || saving}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {engine !== "default" ? (
        <div className="local-runtime-options-row">
          <div className="local-runtime-options-row-info">
            <div className="local-runtime-options-row-label">Model</div>
            <div className="local-runtime-options-row-sublabel">
              {engineModelDescription ??
                (engine === "codex_cli"
                  ? "Model Codex runs agents on."
                  : "Model Claude Code runs agents on.")}
            </div>
          </div>
          <div className="local-runtime-options-model-select">
            <Select
              value={engineModelValue}
              onValueChange={(value) => void handleEngineModelChange(value)}
              options={engineModelOptions}
              disabled={!ready || saving}
              placeholder={engineModels === null ? "Loading…" : undefined}
              aria-label={
                engine === "codex_cli" ? "Codex model" : "Claude Code model"
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
