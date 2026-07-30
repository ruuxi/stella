import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/ui/toast";
import { Button } from "@/ui/button";
import { Keybind } from "@/ui/keybind";
import { useT } from "@/shared/i18n";
import { getSettingsErrorMessage } from "./shared";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "Command"]);

function formatShortcutForDisplay(shortcut: string, offLabel: string): string[] {
  if (!shortcut) return [offLabel];
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

export function ShortcutsTab() {
  const t = useT();
  const actionLabel = useCallback(
    (action: ShortcutAction) => t(`settings.shortcuts.actions.${action}`),
    [t],
  );
  const [shortcuts, setShortcuts] = useState<Record<ShortcutAction, string>>({
    dictation: "Alt",
    voice: "CommandOrControl+Shift+D",
  });
  const [loaded, setLoaded] = useState(false);
  const [savingShortcut, setSavingShortcut] = useState<ShortcutAction | null>(
    null,
  );
  const [capturingShortcut, setCapturingShortcut] =
    useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [dictationShortcut, voiceShortcut] = await Promise.all([
          window.electronAPI?.dictation?.getShortcut?.() ??
            Promise.resolve("Alt"),
          window.electronAPI?.voice?.getRtcShortcut?.() ??
            Promise.resolve("CommandOrControl+Shift+D"),
        ]);
        if (cancelled) return;
        setShortcuts({
          dictation: dictationShortcut,
          voice: voiceShortcut,
        });
        setShortcutError(null);
      } catch (error) {
        if (!cancelled) {
          setShortcutError(
            getSettingsErrorMessage(error, t("settings.shortcuts.errors.load")),
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
  }, [t]);

  const saveShortcut = useCallback(
    async (action: ShortcutAction, shortcut: string) => {
      const setShortcut =
        action === "dictation"
          ? window.electronAPI?.dictation?.setShortcut
          : window.electronAPI?.voice?.setRtcShortcut;
      if (!setShortcut) {
        setShortcutError(t("settings.shortcuts.errors.unavailable"));
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
          const message =
            result.error ?? t("settings.shortcuts.errors.unavailableShortcut");
          setShortcutError(message);
          showToast({
            title: t("settings.shortcuts.toasts.unavailableTitle"),
            description: message,
            variant: "error",
          });
          return;
        }
        showToast({
          title: shortcut
            ? t("settings.shortcuts.toasts.updatedTitle", {
                action: actionLabel(action),
              })
            : t("settings.shortcuts.toasts.clearedTitle", {
                action: actionLabel(action),
              }),
          description: shortcut
            ? t("settings.shortcuts.toasts.updatedDescription", {
                keys: formatShortcutForDisplay(
                  shortcut,
                  t("settings.shortcuts.off"),
                ).join(" + "),
                target: t(`settings.shortcuts.targets.${action}`),
              })
            : t("settings.shortcuts.toasts.clearedDescription", {
                action: actionLabel(action),
              }),
        });
      } catch (error) {
        const message = getSettingsErrorMessage(
          error,
          t("settings.shortcuts.errors.update"),
        );
        setShortcutError(message);
        showToast({
          title: t("settings.shortcuts.toasts.failedTitle"),
          description: message,
          variant: "error",
        });
      } finally {
        setSavingShortcut(null);
        setCapturingShortcut(null);
      }
    },
    [actionLabel, t],
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

  const renderShortcutRow = (action: ShortcutAction, description: string) => (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{actionLabel(action)}</div>
        <div className="settings-row-sublabel">{description}</div>
      </div>
      <div className="settings-row-control">
        <Keybind
          keys={formatShortcutForDisplay(
            shortcuts[action],
            t("settings.shortcuts.off"),
          )}
        />
        <Button
          type="button"
          variant="ghost"
          className="pill-btn"
          disabled={
            !loaded || savingShortcut !== null || capturingShortcut !== null
          }
          onClick={() => setCapturingShortcut(action)}
        >
          {capturingShortcut === action
            ? t("settings.shortcuts.capturing")
            : t("settings.shortcuts.change")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="pill-btn"
          disabled={
            !loaded ||
            savingShortcut !== null ||
            capturingShortcut !== null ||
            !shortcuts[action]
          }
          onClick={() => void saveShortcut(action, "")}
        >
          {t("settings.shortcuts.clear")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">{t("settings.shortcuts.title")}</h3>
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
          t("settings.shortcuts.dictation.description"),
        )}
        {renderShortcutRow(
          "voice",
          t("settings.shortcuts.voiceAgent.description"),
        )}
      </div>
    </div>
  );
}
