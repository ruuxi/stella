import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getDefaultModelOptionLabel,
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "@/global/settings/lib/model-defaults";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import { NativeSelect } from "@/ui/native-select";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import "./ModelsPicker.css";

const PICKER_AGENTS = [
  { key: "orchestrator", label: "Orchestrator" },
  { key: "general", label: "General" },
] as const;

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  generalAgentEngine: "default" | "claude_code_local";
  selfModAgentEngine: "default" | "claude_code_local";
  maxAgentConcurrency: number;
};

interface ModelsPickerProps {
  /** Custom trigger (e.g. icon button). Required. */
  trigger: ReactElement;
  /** Which side of the trigger the popover opens on. Defaults to `top`. */
  side?: "top" | "bottom" | "left" | "right";
  /** Alignment of the popover relative to the trigger. Defaults to `start`. */
  align?: "start" | "center" | "end";
}

/**
 * Compact model-selection surface — only the orchestrator and general
 * agents, surfaced from the sidebar actions bar. Anything more advanced
 * (per-agent overrides, custom model IDs, API keys, runtime engine) lives
 * behind the "More options" link, which deep-links to the Models tab in
 * Settings.
 */
export function ModelsPicker({
  trigger,
  side = "top",
  align = "start",
}: ModelsPickerProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const [preferences, setPreferences] = useState<LocalModelPreferences | null>(
    null,
  );
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const { models: stellaModels, defaults: stellaDefaultModels } =
    useModelCatalog();

  const modelDefaults = useMemo(() => {
    if (!preferences) return undefined;
    return getLocalModelDefaults(
      preferences.defaultModels,
      stellaDefaultModels,
    );
  }, [preferences, stellaDefaultModels]);

  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const model of stellaModels) {
      next.set(model.id, model.name);
      if (model.upstreamModel) next.set(model.upstreamModel, model.name);
    }
    return next;
  }, [stellaModels]);

  const defaultModelMap = useMemo(
    () => buildModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );
  const resolvedDefaultModelMap = useMemo(
    () => buildResolvedModelDefaultsMap(modelDefaults),
    [modelDefaults],
  );

  const overrides = useMemo<Record<string, string>>(() => {
    if (!preferences) return {};
    return normalizeModelOverrides(
      preferences.modelOverrides,
      defaultModelMap,
    );
  }, [defaultModelMap, preferences]);

  // Lazy-load preferences the first time the popover opens — keeps the
  // sidebar's mount path cheap when the user never touches Models.
  useEffect(() => {
    if (!open || preferences !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled && next) setPreferences(next);
      } catch {
        // Errors here are non-fatal — the picker simply renders the loading
        // state until the user retries (closes/re-opens the popover).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, preferences]);

  const handleChange = useCallback(
    async (agentKey: string, value: string) => {
      if (!preferences || pendingAgent) return;
      const previous = { ...preferences.modelOverrides };
      const nextOverrides = { ...previous };
      if (value === "") {
        delete nextOverrides[agentKey];
      } else {
        nextOverrides[agentKey] = value;
      }
      setPendingAgent(agentKey);
      setPreferences({ ...preferences, modelOverrides: nextOverrides });
      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            modelOverrides: nextOverrides,
          });
        if (saved) setPreferences(saved);
      } catch {
        setPreferences((current) =>
          current ? { ...current, modelOverrides: previous } : current,
        );
      } finally {
        setPendingAgent(null);
      }
    },
    [pendingAgent, preferences],
  );

  const handleOpenSettings = useCallback(() => {
    setOpen(false);
    void navigate({ to: "/settings", search: { tab: "models" } });
  }, [navigate]);

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger, { "data-slot": "models-picker-trigger" } as Record<
        string,
        unknown
      >)
    : trigger;

  const ready = preferences !== null && modelDefaults !== undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        collisionPadding={8}
        data-models-picker="true"
      >
        <PopoverBody>
          <div className="models-picker">
            {PICKER_AGENTS.map((agent) => {
              const current = overrides[agent.key] ?? "";
              const showOrphan =
                Boolean(current) &&
                !stellaModels.some((model) => model.id === current);
              const defaultLabel = ready
                ? getDefaultModelOptionLabel(
                    agent.key,
                    defaultModelMap,
                    resolvedDefaultModelMap,
                    modelNamesById,
                  )
                : "Default";
              return (
                <div key={agent.key} className="models-picker-row">
                  <div className="models-picker-label">{agent.label}</div>
                  <NativeSelect
                    className="models-picker-select"
                    value={current}
                    disabled={!ready || pendingAgent === agent.key}
                    onChange={(event) =>
                      void handleChange(agent.key, event.target.value)
                    }
                  >
                    <option value="">{defaultLabel}</option>
                    {showOrphan ? (
                      <option value={current}>
                        {modelNamesById.get(current) ?? current}
                      </option>
                    ) : null}
                    {stellaModels
                      .filter((model) => model.id !== STELLA_DEFAULT_MODEL)
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                  </NativeSelect>
                </div>
              );
            })}
            <button
              type="button"
              className="models-picker-more"
              onClick={handleOpenSettings}
            >
              <span>More options</span>
              <ChevronRight size={14} strokeWidth={1.75} />
            </button>
          </div>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
