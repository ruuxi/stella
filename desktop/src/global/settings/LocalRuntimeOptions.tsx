import { useCallback, useEffect, useState } from "react";
import { getSettingsErrorMessage } from "./tabs/shared";
import "./LocalRuntimeOptions.css";

const ENGINE_OPTIONS = [
  { id: "default", label: "Stella" },
  { id: "claude_code_local", label: "Claude Code" },
] as const;

type EngineId = (typeof ENGINE_OPTIONS)[number]["id"];

const MAX_CONCURRENCY = 48;
const MIN_CONCURRENCY = 1;

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  reasoningEfforts: Record<
    string,
    "minimal" | "low" | "medium" | "high" | "xhigh"
  >;
  agentRuntimeEngine: EngineId;
  maxAgentConcurrency: number;
};

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 24;
  const floored = Math.floor(value);
  if (floored < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (floored > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return floored;
}

/**
 * Engine + concurrency selectors for the local agent runtime. Lives inside
 * the expanded section of `AgentModelPicker` so it shows up in both the
 * sidebar popover and the Settings page model picker without a parallel
 * "Agents" card.
 */
export function LocalRuntimeOptions() {
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftConcurrency, setDraftConcurrency] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled) {
          setPreferences(next ?? null);
          setDraftConcurrency(
            next ? String(clampConcurrency(next.maxAgentConcurrency)) : "",
          );
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

  const commitConcurrency = useCallback(
    async (raw: string) => {
      if (!preferences) return;
      const parsed = clampConcurrency(Number(raw));
      setDraftConcurrency(String(parsed));
      if (parsed === preferences.maxAgentConcurrency || saving) return;
      const previous = preferences;
      setSaving(true);
      setPreferences({ ...preferences, maxAgentConcurrency: parsed });
      setError(null);
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            maxAgentConcurrency: parsed,
          });
        if (saved) {
          setPreferences(saved);
          setDraftConcurrency(String(clampConcurrency(saved.maxAgentConcurrency)));
        }
      } catch (caught) {
        setPreferences(previous);
        setDraftConcurrency(String(previous.maxAgentConcurrency));
        setError(
          getSettingsErrorMessage(
            caught,
            "Failed to update max running tasks.",
          ),
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
            Powers Stella's agents. Claude Code requires the{" "}
            <code>claude</code> command on your computer.
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
      <div className="local-runtime-options-row">
        <div className="local-runtime-options-row-info">
          <div className="local-runtime-options-row-label">
            Max running tasks
          </div>
          <div className="local-runtime-options-row-sublabel">
            How many background tasks Stella can run at once. Up to{" "}
            {MAX_CONCURRENCY}.
          </div>
        </div>
        <input
          type="number"
          inputMode="numeric"
          min={MIN_CONCURRENCY}
          max={MAX_CONCURRENCY}
          step={1}
          className="local-runtime-options-number"
          value={ready ? draftConcurrency : ""}
          placeholder={ready ? undefined : "—"}
          onChange={(event) => setDraftConcurrency(event.target.value)}
          onBlur={(event) => void commitConcurrency(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitConcurrency(event.currentTarget.value);
              event.currentTarget.blur();
            }
          }}
          disabled={!ready || saving}
          aria-label="Max running tasks"
        />
      </div>
    </div>
  );
}
