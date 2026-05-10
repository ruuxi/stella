import { useCallback, useEffect, useState } from "react";
import { getSettingsErrorMessage } from "./tabs/shared";
import "./LocalRuntimeOptions.css";

const ENGINE_OPTIONS = [
  { id: "default", label: "Stella" },
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
};

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
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = preferences !== null;
  const engine: EngineId = preferences?.agentRuntimeEngine ?? "default";

  const handleEngineChange = useCallback(
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
          getSettingsErrorMessage(caught, "Failed to update the agent runtime."),
        );
      } finally {
        setSaving(false);
      }
    },
    [preferences, saving],
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
            Optionally use Claude Code for all agents.
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
    </div>
  );
}
