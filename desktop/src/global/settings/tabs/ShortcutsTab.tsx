import { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "@/ui/toast";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { Keybind } from "@/ui/keybind";
import {
  getRadialTriggerLabel,
  getRadialTriggerOptions,
  type RadialTriggerCode,
} from "@/shared/lib/radial-trigger";
import {
  getMiniDoubleTapModifierLabel,
  MINI_DOUBLE_TAP_MODIFIER_OPTIONS,
  type MiniDoubleTapModifier,
} from "@/shared/lib/mini-double-tap";
import { getSettingsErrorMessage } from "./shared";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "Command"]);

function formatShortcutForDisplay(shortcut: string): string[] {
  if (!shortcut) return ["Off"];
  return shortcut
    .split("+")
    .filter(Boolean)
    .map((part) => {
      switch (part) {
        case "CommandOrControl":
          return window.electronAPI?.platform === "darwin" ? "⌘" : "Ctrl";
        case "Command":
        case "Meta":
          return window.electronAPI?.platform === "darwin" ? "⌘" : "Meta";
        case "Control":
        case "Ctrl":
          return "Ctrl";
        case "Alt":
          return window.electronAPI?.platform === "darwin" ? "⌥" : "Alt";
        case "Shift":
          return "Shift";
        case "Space":
          return "Space";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    });
}

function keyToAcceleratorPart(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
  if (/^[0-9]$/.test(event.key)) return event.key;

  switch (event.key) {
    case " ":
    case "Spacebar":
      return "Space";
    case "Escape":
      return "Escape";
    case "Enter":
      return "Enter";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    default:
      return /^F\d{1,2}$/.test(event.key) ? event.key : null;
  }
}

function keyboardEventToAccelerator(event: KeyboardEvent): string | null {
  const key = keyToAcceleratorPart(event);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Command");
  parts.push(key);
  return parts.join("+");
}

type ShortcutAction = "dictation" | "voice";

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  dictation: "Dictation",
  voice: "Voice agent",
};

// Curated radial-dial trigger options. The underlying catalog includes
// every letter/digit/punctuation key — none of which are sane choices
// for a global "hold to open" trigger (binding to "A" pops the dial
// every time you type a word starting with A). Show only triggers that
// don't disrupt normal typing; the saved value is always added in case
// it's outside the recommended set.
const RECOMMENDED_RADIAL_TRIGGER_CODES: readonly RadialTriggerCode[] = [
  "SystemChord",
  "Backquote",
];

const RADIAL_TRIGGER_LABEL_OVERRIDES: Partial<Record<RadialTriggerCode, string>> = {
  Backquote: "Backtick (`)",
};

export function ShortcutsTab() {
  const platform = window.electronAPI?.platform;
  const allRadialOptions = useMemo(
    () => getRadialTriggerOptions(platform),
    [platform],
  );
  const [shortcuts, setShortcuts] = useState<Record<ShortcutAction, string>>({
    dictation: "Alt",
    voice: "CommandOrControl+Shift+D",
  });
  const [radialTriggerKey, setRadialTriggerKey] =
    useState<RadialTriggerCode>("SystemChord");
  const [miniDoubleTapModifier, setMiniDoubleTapModifier] =
    useState<MiniDoubleTapModifier>("Alt");
  const [loaded, setLoaded] = useState(false);
  const [savingShortcut, setSavingShortcut] = useState<ShortcutAction | null>(
    null,
  );
  const [capturingShortcut, setCapturingShortcut] =
    useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  // Build the curated dropdown: recommended options first, then the
  // currently-saved value if it isn't already in the recommended set.
  // Apply label overrides so e.g. `Backquote` reads as "Backtick (`)"
  // instead of just a bare backtick character.
  const radialOptions = useMemo(() => {
    const codes: RadialTriggerCode[] = [...RECOMMENDED_RADIAL_TRIGGER_CODES];
    if (!codes.includes(radialTriggerKey)) {
      codes.push(radialTriggerKey);
    }
    const labelByCode = new Map(
      allRadialOptions.map((option) => [option.code, option.label] as const),
    );
    return codes.map((code) => ({
      code,
      label:
        RADIAL_TRIGGER_LABEL_OVERRIDES[code] ??
        labelByCode.get(code) ??
        getRadialTriggerLabel(code, platform),
    }));
  }, [allRadialOptions, radialTriggerKey, platform]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [dictationShortcut, voiceShortcut, radialKey, miniModifier] =
          await Promise.all([
            window.electronAPI?.dictation?.getShortcut?.() ??
              Promise.resolve("Alt"),
            window.electronAPI?.voice?.getRtcShortcut?.() ??
              Promise.resolve("CommandOrControl+Shift+D"),
            window.electronAPI?.system?.getRadialTriggerKey?.() ??
              Promise.resolve("SystemChord" as RadialTriggerCode),
            window.electronAPI?.system?.getMiniDoubleTapModifier?.() ??
              Promise.resolve("Alt" as MiniDoubleTapModifier),
          ]);
        if (cancelled) return;
        setShortcuts({
          dictation: dictationShortcut,
          voice: voiceShortcut,
        });
        setRadialTriggerKey(radialKey);
        setMiniDoubleTapModifier(miniModifier);
        setShortcutError(null);
      } catch (error) {
        if (!cancelled) {
          setShortcutError(
            getSettingsErrorMessage(error, "Failed to load shortcuts."),
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveShortcut = useCallback(
    async (action: ShortcutAction, shortcut: string) => {
      const setShortcut =
        action === "dictation"
          ? window.electronAPI?.dictation?.setShortcut
          : window.electronAPI?.voice?.setRtcShortcut;
      if (!setShortcut) {
        setShortcutError("Shortcuts are unavailable in this window.");
        return;
      }

      setSavingShortcut(action);
      setShortcutError(null);
      try {
        const result = await setShortcut(shortcut);
        setShortcuts((current) => ({
          ...current,
          [action]: result.activeShortcut,
        }));
        if (!result.ok) {
          const message = result.error ?? "That shortcut is unavailable.";
          setShortcutError(message);
          showToast({
            title: "Shortcut unavailable",
            description: message,
            variant: "error",
          });
          return;
        }
        showToast({
          title: shortcut
            ? `${SHORTCUT_LABELS[action]} shortcut updated`
            : `${SHORTCUT_LABELS[action]} shortcut cleared`,
          description: shortcut
            ? `Press ${formatShortcutForDisplay(shortcut).join(" + ")} to start ${action === "dictation" ? "dictation" : "the voice agent"}.`
            : `${SHORTCUT_LABELS[action]} is disabled until you set a new shortcut.`,
        });
      } catch (error) {
        const message = getSettingsErrorMessage(
          error,
          "Failed to update shortcut.",
        );
        setShortcutError(message);
        showToast({
          title: "Shortcut update failed",
          description: message,
          variant: "error",
        });
      } finally {
        setSavingShortcut(null);
        setCapturingShortcut(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (!capturingShortcut) return;
    const setShortcutCaptureSuspended = (suspended: boolean) =>
      window.electronAPI?.system?.setGlobalShortcutsSuspended?.(suspended) ??
      Promise.resolve({ supported: false, suspended: false });
    void setShortcutCaptureSuspended(true);

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        void setShortcutCaptureSuspended(false);
        setCapturingShortcut(null);
        return;
      }

      const accelerator = keyboardEventToAccelerator(event);
      if (!accelerator) return;
      void setShortcutCaptureSuspended(false).finally(() => {
        void saveShortcut(capturingShortcut, accelerator);
      });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      void setShortcutCaptureSuspended(false);
    };
  }, [capturingShortcut, saveShortcut]);

  const saveRadialTrigger = useCallback(
    async (triggerKey: RadialTriggerCode) => {
      const api = window.electronAPI?.system;
      if (!api?.setRadialTriggerKey) return;
      setShortcutError(null);
      try {
        const result = await api.setRadialTriggerKey(triggerKey);
        setRadialTriggerKey(result.triggerKey);
        showToast({
          title: "Radial dial shortcut updated",
          description: `Hold ${getRadialTriggerLabel(result.triggerKey, platform)} to open the radial dial.`,
        });
      } catch (error) {
        setShortcutError(
          getSettingsErrorMessage(
            error,
            "Failed to update radial dial shortcut.",
          ),
        );
      }
    },
    [platform],
  );

  const saveMiniDoubleTap = useCallback(
    async (modifier: MiniDoubleTapModifier) => {
      const api = window.electronAPI?.system;
      if (!api?.setMiniDoubleTapModifier) return;
      setShortcutError(null);
      try {
        const result = await api.setMiniDoubleTapModifier(modifier);
        setMiniDoubleTapModifier(result.modifier);
        showToast({
          title: "Mini window shortcut updated",
          description:
            result.modifier === "Off"
              ? "Double-tap is disabled."
              : `Double-tap ${getMiniDoubleTapModifierLabel(result.modifier, platform)} to open the mini window.`,
        });
      } catch (error) {
        setShortcutError(
          getSettingsErrorMessage(
            error,
            "Failed to update mini window shortcut.",
          ),
        );
      }
    },
    [platform],
  );

  const renderShortcutRow = (action: ShortcutAction, description: string) => (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{SHORTCUT_LABELS[action]}</div>
        <div className="settings-row-sublabel">{description}</div>
      </div>
      <div className="settings-row-control">
        <Keybind keys={formatShortcutForDisplay(shortcuts[action])} />
        <Button
          type="button"
          variant="ghost"
          className="settings-btn"
          disabled={
            !loaded || savingShortcut !== null || capturingShortcut !== null
          }
          onClick={() => setCapturingShortcut(action)}
        >
          {capturingShortcut === action ? "Press keys..." : "Change"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="settings-btn"
          disabled={
            !loaded ||
            savingShortcut !== null ||
            capturingShortcut !== null ||
            !shortcuts[action]
          }
          onClick={() => void saveShortcut(action, "")}
        >
          Clear
        </Button>
      </div>
    </div>
  );

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Shortcuts</h3>
        {shortcutError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {shortcutError}
          </p>
        ) : null}
        {renderShortcutRow(
          "dictation",
          "Hold Option to dictate into Stella or the app you're using.",
        )}
        {renderShortcutRow(
          "voice",
          "Starts or stops Stella's live voice agent.",
        )}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Radial dial</div>
            <div className="settings-row-sublabel">
              Opens the wedge menu for capture, chat, voice, and quick actions.
            </div>
          </div>
          <div className="settings-row-control">
            <Select<RadialTriggerCode>
              className="settings-runtime-select"
              value={radialTriggerKey}
              disabled={!loaded}
              aria-label="Radial dial shortcut"
              onValueChange={(value) => void saveRadialTrigger(value)}
              options={radialOptions.map((option) => ({
                value: option.code,
                label: option.label,
              }))}
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Mini window</div>
            <div className="settings-row-sublabel">
              Double-tap a modifier key to open or dismiss the mini chat.
            </div>
          </div>
          <div className="settings-row-control">
            <Select<MiniDoubleTapModifier>
              className="settings-runtime-select"
              value={miniDoubleTapModifier}
              disabled={!loaded}
              aria-label="Mini window shortcut"
              onValueChange={(value) => void saveMiniDoubleTap(value)}
              options={MINI_DOUBLE_TAP_MODIFIER_OPTIONS.map((modifier) => ({
                value: modifier,
                label: getMiniDoubleTapModifierLabel(modifier, platform),
              }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
