import {
  lazy,
  Suspense,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { PageSidebar } from "@/context/page-sidebar";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { authClient } from "@/global/auth/lib/auth-client";
import { clearCachedToken } from "@/global/auth/services/auth-token";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getConfigurableAgents,
  getDefaultModelOptionLabel,
  getLocalModelDefaults,
  normalizeModelOverrides,
  type ModelDefaultEntry,
} from "@/global/settings/lib/model-defaults";
import { showToast } from "@/ui/toast";
import type {
  BackupStatusSnapshot,
  BackupSummary,
  LocalLlmCredentialSummary,
  LocalLlmOAuthProviderSummary,
} from "@/shared/types/electron";
import type { LegalDocument } from "@/global/legal/legal-text";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { NativeSelect } from "@/ui/native-select";
import { Switch } from "@/ui/switch";
import { Keybind } from "@/ui/keybind";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { AudioTab } from "@/global/settings/AudioTab";
import { SettingsPanel } from "@/global/settings/SettingsPanel";
import {
  SETTINGS_TABS,
  type SettingsTab,
} from "@/global/settings/settings-tabs";
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
import {
  useDesktopPermissions,
  type DesktopPermissionStatus,
} from "@/global/permissions/use-desktop-permissions";
import {
  setDeveloperResourcePreviewsEnabled,
  useDeveloperResourcePreviewsEnabled,
} from "@/shared/lib/developer-resource-previews";
import "@/global/settings/settings.css";

const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({
    default: m.LegalDialog,
  })),
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERAL_AGENT_ENGINE_OPTIONS = [
  { id: "default", name: "Stella" },
  { id: "claude_code_local", name: "Claude Code" },
] as const;
const SETTINGS_PERMISSION_RESTART_KINDS = ["screen"] as const;

const MAX_AGENT_CONCURRENCY_OPTIONS = Array.from(
  { length: 24 },
  (_, index) => index + 1,
);

type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  resolvedDefaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  generalAgentEngine: "default" | "claude_code_local";
  selfModAgentEngine: "default" | "claude_code_local";
  maxAgentConcurrency: number;
};

const LLM_PROVIDERS = [
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { key: "openai", label: "OpenAI", placeholder: "sk-..." },
  { key: "openai-codex", label: "OpenAI Codex", placeholder: "eyJ..." },
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
  { key: "github-copilot", label: "GitHub Copilot", placeholder: "OAuth only" },
  { key: "google-gemini-cli", label: "Gemini CLI", placeholder: "OAuth only" },
  {
    key: "google-antigravity",
    label: "Google Antigravity",
    placeholder: "OAuth only",
  },
] as const;

function getSettingsErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

type AccountDeleteAction = "data" | "account";

const deleteIndexedDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

async function clearLocalAccountState() {
  clearCachedToken();

  try {
    localStorage.clear();
  } catch {
    /* best-effort local cleanup */
  }

  try {
    sessionStorage.clear();
  } catch {
    /* best-effort local cleanup */
  }

  if (
    typeof indexedDB !== "undefined" &&
    typeof indexedDB.databases === "function"
  ) {
    try {
      const databases = await indexedDB.databases();
      const names = databases
        .map((database) => database.name)
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        );
      await Promise.all(names.map(deleteIndexedDatabase));
    } catch {
      /* best-effort local cleanup */
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName)),
      );
    } catch {
      /* best-effort local cleanup */
    }
  }

  await window.electronAPI?.ui.hardReset?.();
}

async function deleteCurrentBetterAuthUser() {
  const client = authClient as typeof authClient & {
    deleteUser?: (body?: { callbackURL?: string }) => Promise<unknown>;
  };
  if (typeof client.deleteUser !== "function") {
    throw new Error("Account deletion is not available.");
  }
  await client.deleteUser({ callbackURL: "/" });
}

function isStellaSelection(value: string | undefined) {
  return Boolean(value) && value!.startsWith("stella/");
}

function formatBackupTimestamp(timestamp?: number) {
  if (!timestamp) {
    return "Never";
  }
  return new Date(timestamp).toLocaleString();
}

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

// ---------------------------------------------------------------------------
// General Settings Sections
// ---------------------------------------------------------------------------

type ShortcutAction = "dictation" | "voice";

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  dictation: "Dictation",
  voice: "Voice agent",
};

function ShortcutsSettingsTab() {
  const platform = window.electronAPI?.platform;
  const radialOptions = useMemo(
    () => getRadialTriggerOptions(platform),
    [platform],
  );
  const [shortcuts, setShortcuts] = useState<Record<ShortcutAction, string>>({
    dictation: "Control+M",
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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [dictationShortcut, voiceShortcut, radialKey, miniModifier] =
          await Promise.all([
            window.electronAPI?.dictation?.getShortcut?.() ??
              Promise.resolve("Control+M"),
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

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setCapturingShortcut(null);
        return;
      }

      const accelerator = keyboardEventToAccelerator(event);
      if (!accelerator) return;
      void saveShortcut(capturingShortcut, accelerator);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
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
        <p className="settings-card-desc">
          Change how Stella opens, listens, and starts voice.
        </p>
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
          "Starts in the active Stella composer, or opens OS-wide dictation when another app is focused.",
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
            <NativeSelect
              className="settings-runtime-select"
              value={radialTriggerKey}
              disabled={!loaded}
              aria-label="Radial dial shortcut"
              onChange={(event) =>
                void saveRadialTrigger(event.target.value as RadialTriggerCode)
              }
            >
              {radialOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
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
            <NativeSelect
              className="settings-runtime-select"
              value={miniDoubleTapModifier}
              disabled={!loaded}
              aria-label="Mini window shortcut"
              onChange={(event) =>
                void saveMiniDoubleTap(
                  event.target.value as MiniDoubleTapModifier,
                )
              }
            >
              {MINI_DOUBLE_TAP_MODIFIER_OPTIONS.map((modifier) => (
                <option key={modifier} value={modifier}>
                  {getMiniDoubleTapModifierLabel(modifier, platform)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>
    </div>
  );
}

function BasicSettingsTab() {
  const platform = window.electronAPI?.platform;
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const [preventComputerSleep, setPreventComputerSleep] = useState(false);
  const [preventSleepLoaded, setPreventSleepLoaded] = useState(false);
  const [isSavingPreventSleep, setIsSavingPreventSleep] = useState(false);
  const [preventSleepError, setPreventSleepError] = useState<string | null>(
    null,
  );
  const initialPermissionStatus = useMemo<DesktopPermissionStatus>(
    () => ({
      accessibility: platform === "darwin" ? false : true,
      screen: platform === "darwin" ? false : true,
      microphone: platform === "darwin" ? false : true,
      microphoneStatus: platform === "darwin" ? "unknown" : "granted",
    }),
    [platform],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const enabled =
          await window.electronAPI?.system?.getPreventComputerSleep?.();
        if (!cancelled) {
          setPreventComputerSleep(enabled === true);
          setPreventSleepError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setPreventSleepError(
            getSettingsErrorMessage(error, "Failed to load power setting."),
          );
        }
      } finally {
        if (!cancelled) setPreventSleepLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePreventSleepChange = useCallback(
    async (checked: boolean) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setPreventComputerSleep) {
        setPreventSleepError("Power settings are unavailable in this window.");
        return;
      }

      const previous = preventComputerSleep;
      setPreventComputerSleep(checked);
      setPreventSleepError(null);
      setIsSavingPreventSleep(true);
      try {
        const result = await systemApi.setPreventComputerSleep(checked);
        setPreventComputerSleep(result.enabled);
      } catch (error) {
        setPreventComputerSleep(previous);
        setPreventSleepError(
          getSettingsErrorMessage(error, "Failed to update power setting."),
        );
      } finally {
        setIsSavingPreventSleep(false);
      }
    },
    [preventComputerSleep],
  );
  const formatPermissionLoadError = useCallback(
    (error: unknown) =>
      getSettingsErrorMessage(
        error,
        "Failed to load desktop permission status.",
      ),
    [],
  );
  const {
    status: permissionStatus,
    loaded: permissionsLoaded,
    error: permissionsError,
    setError: setPermissionsError,
    activeAction: activePermissionAction,
    restartRecommended: screenRestartRecommended,
    isRestarting: isRestartingAfterPermissions,
    requestWithSettingsFallback,
    restart: restartAfterPermissionChange,
  } = useDesktopPermissions({
    enabled: platform === "darwin",
    pollMs: 1500,
    initialStatus: initialPermissionStatus,
    restartKinds: SETTINGS_PERMISSION_RESTART_KINDS,
    errorMessage: formatPermissionLoadError,
  });

  const handlePermissionEnable = useCallback(
    async (kind: "accessibility" | "screen") => {
      setPermissionsError(null);
      try {
        await requestWithSettingsFallback(kind);
      } catch (error) {
        setPermissionsError(
          getSettingsErrorMessage(
            error,
            `Failed to update ${kind} permission.`,
          ),
        );
      }
    },
    [requestWithSettingsFallback, setPermissionsError],
  );

  const handlePermissionRestart = useCallback(async () => {
    setPermissionsError(null);
    try {
      await restartAfterPermissionChange();
    } catch (error) {
      setPermissionsError(
        getSettingsErrorMessage(error, "Failed to restart Stella."),
      );
    }
  }, [restartAfterPermissionChange, setPermissionsError]);

  const [resettingPermission, setResettingPermission] = useState<
    "accessibility" | "screen" | "microphone" | null
  >(null);
  const handlePermissionReset = useCallback(
    async (kind: "accessibility" | "screen" | "microphone") => {
      const reset = window.electronAPI?.system.resetPermission;
      if (!reset) return;
      setPermissionsError(null);
      setResettingPermission(kind);
      try {
        const result = await reset(kind);
        if (!result?.ok) {
          setPermissionsError(
            `Could not reset ${kind} permission. Stella may need to be reopened.`,
          );
        }
      } catch (error) {
        setPermissionsError(
          getSettingsErrorMessage(error, `Failed to reset ${kind} permission.`),
        );
      } finally {
        setResettingPermission(null);
      }
    },
    [setPermissionsError],
  );

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Chat previews</h3>
        <p className="settings-card-desc">
          Choose which work files Stella can show directly in chat.
        </p>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Developer file previews</div>
            <div className="settings-row-sublabel">
              Show code changes in chat and open them in the side panel.
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={developerResourcePreviewsEnabled}
              onCheckedChange={(checked) =>
                setDeveloperResourcePreviewsEnabled(Boolean(checked))
              }
            />
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Power</h3>
        <p className="settings-card-desc">
          Keep this computer awake while Stella is running.
        </p>
        {preventSleepError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {preventSleepError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Prevent sleep</div>
            <div className="settings-row-sublabel">
              Stop macOS or Windows from putting the computer to sleep while
              Stella is open.
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={preventComputerSleep}
              disabled={!preventSleepLoaded || isSavingPreventSleep}
              onCheckedChange={(checked) =>
                void handlePreventSleepChange(Boolean(checked))
              }
              hideLabel
            />
          </div>
        </div>
      </div>
      {platform === "darwin" ? (
        <div className="settings-card">
          <h3 className="settings-card-title">Permissions</h3>
          <p className="settings-card-desc">
            Stella will ask for these when you first use a feature. You can also
            turn them on here.
          </p>
          {permissionsError ? (
            <p
              className="settings-card-desc settings-card-desc--error"
              role="alert"
            >
              {permissionsError}
            </p>
          ) : null}
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Accessibility</div>
              <div className="settings-row-sublabel">
                Lets Stella read selected text and open from the ⌘+right-click
                shortcut anywhere on your Mac.
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded ||
                  permissionStatus.accessibility ||
                  activePermissionAction === "accessibility"
                }
                onClick={() => void handlePermissionEnable("accessibility")}
              >
                {permissionStatus.accessibility
                  ? "Granted"
                  : activePermissionAction === "accessibility"
                    ? "Opening..."
                    : "Enable"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded || resettingPermission === "accessibility"
                }
                onClick={() => void handlePermissionReset("accessibility")}
              >
                {resettingPermission === "accessibility"
                  ? "Resetting..."
                  : "Reset"}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Screen Capture</div>
              <div className="settings-row-sublabel">
                Lets Stella see your screen so it can help with what you're
                looking at. You may need to quit and reopen Stella after turning
                this on.
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded ||
                  permissionStatus.screen ||
                  activePermissionAction === "screen"
                }
                onClick={() => void handlePermissionEnable("screen")}
              >
                {permissionStatus.screen
                  ? "Granted"
                  : activePermissionAction === "screen"
                    ? "Opening..."
                    : "Enable"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded || resettingPermission === "screen"
                }
                onClick={() => void handlePermissionReset("screen")}
              >
                {resettingPermission === "screen" ? "Resetting..." : "Reset"}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Microphone</div>
              <div className="settings-row-sublabel">
                Used for voice and dictation. Reset if Stella was previously
                denied and macOS won't prompt again.
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled
              >
                {permissionStatus.microphone ? "Granted" : "Not granted"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded || resettingPermission === "microphone"
                }
                onClick={() => void handlePermissionReset("microphone")}
              >
                {resettingPermission === "microphone"
                  ? "Resetting..."
                  : "Reset"}
              </Button>
            </div>
          </div>
          {screenRestartRecommended ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-label">Restart Stella</div>
                <div className="settings-row-sublabel">
                  Screen capture was just turned on. Quit and reopen Stella to
                  finish setting it up.
                </div>
              </div>
              <div className="settings-row-control">
                <Button
                  type="button"
                  variant="ghost"
                  className="settings-btn settings-btn--danger"
                  disabled={isRestartingAfterPermissions}
                  onClick={() => void handlePermissionRestart()}
                >
                  {isRestartingAfterPermissions ? "Closing..." : "Restart"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BackupSettingsTab() {
  const { hasConnectedAccount } = useAuthSessionState();
  const [billingNowMs] = useState(() => Date.now());
  const billingStatus = useQuery(api.billing.getSubscriptionStatus, {
    now: billingNowMs,
  });
  const setRemoteSyncMode = useMutation(api.data.preferences.setSyncMode);
  const [syncMode, setSyncMode] = useState<"on" | "off">("off");
  const [backupStatus, setBackupStatus] = useState<BackupStatusSnapshot | null>(
    null,
  );
  const [remoteBackups, setRemoteBackups] = useState<BackupSummary[]>([]);
  const [backupLoaded, setBackupLoaded] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [isSavingSyncMode, setIsSavingSyncMode] = useState(false);
  const [isRunningBackup, setIsRunningBackup] = useState(false);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(
    null,
  );
  const isBillingStatusLoading =
    hasConnectedAccount && billingStatus === undefined;
  const isBackupUpgradeRequired =
    hasConnectedAccount &&
    billingStatus !== undefined &&
    billingStatus.plan === "free";

  const loadBackupState = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (
      !systemApi?.getLocalSyncMode ||
      !systemApi.getBackupStatus ||
      !systemApi.listBackups
    ) {
      setBackupLoaded(true);
      setBackupStatus(null);
      setRemoteBackups([]);
      return;
    }
    const nextSyncMode =
      (await systemApi.getLocalSyncMode()) === "on" ? "on" : "off";
    const nextStatus = await systemApi.getBackupStatus();
    const nextBackups = hasConnectedAccount
      ? await systemApi.listBackups(10)
      : [];
    setSyncMode(nextSyncMode);
    setBackupStatus(nextStatus);
    setRemoteBackups(nextBackups);
  }, [hasConnectedAccount]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await loadBackupState();
        if (!cancelled) {
          setBackupError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setBackupError(
            getSettingsErrorMessage(error, "Failed to load backup settings."),
          );
          setRemoteBackups([]);
        }
      } finally {
        if (!cancelled) {
          setBackupLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadBackupState]);

  const handleSyncModeChange = useCallback(
    async (value: string) => {
      const nextMode = value === "on" ? "on" : "off";
      if (isSavingSyncMode) {
        return;
      }
      const previousMode = syncMode;
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setLocalSyncMode) {
        setBackupError("Backup settings are unavailable in this window.");
        return;
      }
      if (nextMode === "on" && !hasConnectedAccount) {
        setBackupError("Sign in and choose a Stella plan to turn on backups.");
        return;
      }
      if (nextMode === "on" && isBillingStatusLoading) {
        setBackupError("Checking your Stella plan before turning on backups.");
        return;
      }
      if (nextMode === "on" && isBackupUpgradeRequired) {
        setBackupError("Backups require an active Stella subscription.");
        return;
      }
      setBackupError(null);
      setSyncMode(nextMode);
      setIsSavingSyncMode(true);
      try {
        if (hasConnectedAccount) {
          await setRemoteSyncMode({ mode: nextMode });
        }
        await systemApi.setLocalSyncMode(nextMode);
        await loadBackupState();
      } catch (error) {
        setSyncMode(previousMode);
        setBackupError(
          getSettingsErrorMessage(error, "Failed to update backup mode."),
        );
      } finally {
        setIsSavingSyncMode(false);
      }
    },
    [
      hasConnectedAccount,
      isBackupUpgradeRequired,
      isBillingStatusLoading,
      isSavingSyncMode,
      loadBackupState,
      setRemoteSyncMode,
      syncMode,
    ],
  );

  const handleBackupNow = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.backUpNow) {
      setBackupError("Backup is unavailable in this window.");
      return;
    }
    setBackupError(null);
    setIsRunningBackup(true);
    try {
      const result = await systemApi.backUpNow();
      await loadBackupState();
      showToast({
        title:
          result.status === "completed"
            ? "Backup completed"
            : result.status === "queued"
              ? "Backup queued"
              : result.status === "deferred"
                ? "Backup deferred"
                : "No backup needed",
        description: result.message,
      });
    } catch (error) {
      const message = getSettingsErrorMessage(error, "Failed to start backup.");
      setBackupError(message);
      showToast({
        title: "Backup failed",
        description: message,
        variant: "error",
      });
    } finally {
      setIsRunningBackup(false);
    }
  }, [loadBackupState]);

  const handleRestoreBackup = useCallback(async (snapshotId: string) => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.restoreBackup) {
      setBackupError("Restore is unavailable in this window.");
      return;
    }
    setBackupError(null);
    setRestoringSnapshotId(snapshotId);
    try {
      await systemApi.restoreBackup(snapshotId);
      showToast({
        title: "Restore prepared",
        description: "Stella will restart to finish applying this backup.",
      });
    } catch (error) {
      const message = getSettingsErrorMessage(
        error,
        "Failed to restore backup.",
      );
      setBackupError(message);
      showToast({
        title: "Restore failed",
        description: message,
        variant: "error",
      });
    } finally {
      setRestoringSnapshotId(null);
    }
  }, []);

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Backups</h3>
        <p className="settings-card-desc">
          Your data is encrypted on this device before it's uploaded. Restoring
          a backup replaces your current Stella data and restarts the app.
        </p>
        {backupError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {backupError}
          </p>
        ) : null}
        {isBackupUpgradeRequired ? (
          <p className="settings-card-desc">
            Backups are included with any paid Stella plan.
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Automatic backups</div>
            <div className="settings-row-sublabel">
              Last local backup:{" "}
              {formatBackupTimestamp(backupStatus?.lastSuccessAt)}
            </div>
            <div className="settings-row-sublabel">
              Last remote backup:{" "}
              {formatBackupTimestamp(backupStatus?.lastRemoteSuccessAt)}
            </div>
            {backupStatus?.lastRemoteError ? (
              <div className="settings-row-sublabel">
                Remote backup issue: {backupStatus.lastRemoteError}
              </div>
            ) : null}
          </div>
          <div className="settings-row-control">
            <NativeSelect
              className="settings-runtime-select"
              value={syncMode}
              onChange={(event) =>
                void handleSyncModeChange(event.target.value)
              }
              disabled={
                !backupLoaded || isSavingSyncMode || isBillingStatusLoading
              }
            >
              <option value="off">Off</option>
              <option value="on">Automatic hourly backups</option>
            </NativeSelect>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Back up now</div>
            <div className="settings-row-sublabel">
              Save a backup right now. It uploads automatically when you're
              signed in.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => void handleBackupNow()}
              disabled={
                !backupLoaded || isRunningBackup || Boolean(restoringSnapshotId)
              }
            >
              {isRunningBackup ? "Backing Up..." : "Back Up Now"}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Saved backups</div>
            <div className="settings-row-sublabel">
              {hasConnectedAccount
                ? "Pick a backup to restore on this device."
                : "Sign in to save backups online and restore them on any device."}
            </div>
          </div>
        </div>
        {hasConnectedAccount && remoteBackups.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-sublabel">
                No remote backups yet.
              </div>
            </div>
          </div>
        ) : null}
        {hasConnectedAccount
          ? remoteBackups.map((backup) => (
              <div key={backup.snapshotId} className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-label">
                    {formatBackupTimestamp(backup.createdAt)}
                    {backup.isLatest ? " (Latest)" : ""}
                  </div>
                  <div className="settings-row-sublabel">
                    {backup.entryCount} files
                  </div>
                  <div className="settings-row-sublabel">
                    From: {backup.sourceHostname || backup.sourceDeviceId}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn"
                    onClick={() => void handleRestoreBackup(backup.snapshotId)}
                    disabled={
                      isRunningBackup ||
                      restoringSnapshotId === backup.snapshotId
                    }
                  >
                    {restoringSnapshotId === backup.snapshotId
                      ? "Restoring..."
                      : "Restore"}
                  </Button>
                </div>
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

function AccountSettingsTab({
  onSignOut,
  onOpenLegal,
}: {
  onSignOut?: () => void;
  onOpenLegal?: (doc: LegalDocument) => void;
}) {
  const { hasConnectedAccount } = useAuthSessionState();
  const resetUserData = useAction(api.reset.resetAllUserData);
  const [pendingDeleteAction, setPendingDeleteAction] =
    useState<AccountDeleteAction | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const closeDeleteDialog = useCallback(
    (open: boolean) => {
      if (!open && !isDeleting) {
        setPendingDeleteAction(null);
      }
    },
    [isDeleting],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteAction || isDeleting) return;
    const action = pendingDeleteAction;
    setIsDeleting(true);

    try {
      if (action === "data") {
        if (hasConnectedAccount) {
          await resetUserData();
        }
      } else {
        if (!hasConnectedAccount) {
          throw new Error("Sign in before deleting your account.");
        }
        await deleteCurrentBetterAuthUser();
      }

      await clearLocalAccountState();
      showToast(
        action === "data"
          ? "Your Stella data was deleted."
          : "Your Stella account was deleted.",
      );
      window.location.reload();
    } catch (error) {
      console.error(error);
      showToast(
        getSettingsErrorMessage(
          error,
          action === "data"
            ? "Could not delete your data. Please try again."
            : "Could not delete your account. Please try again.",
        ),
      );
      setIsDeleting(false);
      setPendingDeleteAction(null);
    }
  }, [hasConnectedAccount, isDeleting, pendingDeleteAction, resetUserData]);

  const deleteDialogTitle =
    pendingDeleteAction === "account"
      ? "Delete your Stella account?"
      : "Delete your Stella data?";
  const deleteDialogDescription =
    pendingDeleteAction === "account"
      ? "This permanently deletes your account and Stella data. This cannot be undone."
      : "This erases your conversations, memory, settings, and local Stella state. This cannot be undone.";
  const deleteDialogButton =
    pendingDeleteAction === "account" ? "Delete account" : "Delete data";

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Account</h3>
        <p className="settings-card-desc">Manage your Stella account.</p>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Sign out</div>
            <div className="settings-row-sublabel">
              Sign out of Stella on this device.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={onSignOut}
            >
              Sign Out
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete data</div>
            <div className="settings-row-sublabel">
              Erase every conversation, memory, and saved Stella setting.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              onClick={() => setPendingDeleteAction("data")}
              disabled={isDeleting}
            >
              {isDeleting && pendingDeleteAction === "data"
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete account</div>
            <div className="settings-row-sublabel">
              Permanently delete your account and everything in it.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              onClick={() => setPendingDeleteAction("account")}
              disabled={isDeleting || !hasConnectedAccount}
            >
              {isDeleting && pendingDeleteAction === "account"
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Legal</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Terms of Service</div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("terms")}
            >
              View
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Privacy Policy</div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => onOpenLegal?.("privacy")}
            >
              View
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={pendingDeleteAction !== null}
        onOpenChange={closeDeleteDialog}
      >
        <DialogContent
          fit
          className="settings-confirm-dialog"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{deleteDialogTitle}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="settings-confirm-description">
            {deleteDialogDescription}
          </DialogDescription>
          <div className="settings-confirm-actions">
            <Button
              type="button"
              variant="ghost"
              size="large"
              className="pill-btn pill-btn--lg"
              onClick={() => setPendingDeleteAction(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="large"
              data-tone="destructive"
              className="pill-btn pill-btn--danger pill-btn--lg"
              onClick={() => void handleConfirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : deleteDialogButton}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chronicle + Dream Memory Card
// ---------------------------------------------------------------------------

type ChronicleStatus = {
  enabled: boolean;
  running: boolean;
  paused?: boolean;
  fps?: number;
  captures?: number;
  lastCaptureAt?: number | null;
};

function formatPendingDreamInputs(
  pendingThreadSummaries: number,
  pendingExtensions: number,
): string | undefined {
  const parts: string[] = [];
  if (pendingThreadSummaries > 0) {
    parts.push(
      `${pendingThreadSummaries} task ${pendingThreadSummaries === 1 ? "summary" : "summaries"}`,
    );
  }
  if (pendingExtensions > 0) {
    parts.push(
      `${pendingExtensions} Chronicle ${pendingExtensions === 1 ? "file" : "files"}`,
    );
  }
  return parts.length > 0 ? `Pending: ${parts.join(" and ")}.` : undefined;
}

function formatChronicleEnableFailure(args: {
  reason?: string;
  detail?: string;
}): string {
  switch (args.reason) {
    case "no-stella-root":
      return "Stella's workspace root is unavailable.";
    case "needs-permission":
      return "Screen Recording permission is still required before Chronicle can start.";
    case "binary-missing":
      return "The Chronicle helper binary is missing.";
    case "startup-timeout":
      return "Chronicle did not come online after launch.";
    case "unsupported-platform":
      return "Chronicle is only available on macOS.";
    default:
      return args.detail ?? args.reason ?? "Unknown error.";
  }
}

function formatDreamRunResult(args: {
  ok: boolean;
  reason?: string;
  pendingThreadSummaries: number;
  pendingExtensions: number;
  detail?: string;
}): string | undefined {
  const pending = formatPendingDreamInputs(
    args.pendingThreadSummaries,
    args.pendingExtensions,
  );
  switch (args.reason) {
    case "scheduled":
      return pending ?? "Dream will consolidate the current backlog.";
    case "in_flight":
      return "A Dream pass is already running.";
    case "no_inputs":
      return "There is nothing new to consolidate right now.";
    case "no_api_key":
      return "Dream needs a configured model/API key or signed-in Stella route.";
    case "disabled":
      return "Dream scheduling is currently disabled.";
    case "below_threshold":
      return pending ?? "The idle threshold has not been reached yet.";
    case "lock_busy":
      return "Dream is busy right now. Try again in a moment.";
    case "no-runner":
      return "The local runtime is not ready yet.";
    case "no-stella-root":
      return "Stella's workspace root is unavailable.";
    case "unavailable":
      return args.detail ?? "Dream is currently unavailable.";
    default:
      return args.detail ?? args.reason ?? pending;
  }
}

function ChronicleSettingsCard() {
  const chronicleApi = window.electronAPI?.chronicle;
  const [available, setAvailable] = useState<boolean>(true);
  const [status, setStatus] = useState<ChronicleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "toggle" | "dream" | "wipe" | "open">(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!chronicleApi?.status) {
      setAvailable(false);
      setLoading(false);
      return;
    }
    try {
      const result = await chronicleApi.status();
      setAvailable(result.available);
      setStatus(result.status ?? null);
      setError(null);
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, "Failed to load Chronicle status."),
      );
    } finally {
      setLoading(false);
    }
  }, [chronicleApi]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    if (!chronicleApi?.setEnabled) return;
    setBusy("toggle");
    setError(null);
    try {
      const result = await chronicleApi.setEnabled(next);
      if (!result.ok) {
        const message = formatChronicleEnableFailure(result);
        setError(message);
        showToast({
          title: next
            ? "Could not enable Chronicle"
            : "Could not disable Chronicle",
          description: message,
          variant: "error",
        });
      } else {
        showToast({
          title: next ? "Chronicle enabled" : "Chronicle disabled",
          description:
            result.reason === "already-running"
              ? "Chronicle was already running."
              : undefined,
          variant: "default",
        });
      }
      await refresh();
    } catch (caught) {
      setError(getSettingsErrorMessage(caught, "Failed to update Chronicle."));
    } finally {
      setBusy(null);
    }
  };

  const handleDreamNow = async () => {
    if (!chronicleApi?.dreamNow) return;
    setBusy("dream");
    setError(null);
    try {
      const result = await chronicleApi.dreamNow();
      const description = formatDreamRunResult(result);
      showToast({
        title: result.ok ? "Dream pass scheduled" : "Dream pass not scheduled",
        description,
        variant: result.ok ? "success" : "error",
      });
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, "Failed to trigger Dream pass."),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleOpenFolder = async () => {
    if (!chronicleApi?.openMemoriesFolder) return;
    setBusy("open");
    try {
      await chronicleApi.openMemoriesFolder();
    } finally {
      setBusy(null);
    }
  };

  const handleWipe = async () => {
    if (!chronicleApi?.wipeMemories) return;
    const confirmed = window.confirm(
      "Erase everything Stella has remembered? This cannot be undone.",
    );
    if (!confirmed) return;
    setBusy("wipe");
    setError(null);
    try {
      const result = await chronicleApi.wipeMemories();
      if (!result.ok) {
        const message = result.reason ?? "Failed to wipe memories.";
        setError(message);
        showToast({
          title: "Wipe failed",
          description: message,
          variant: "error",
        });
        return;
      }
      showToast({
        title: "Memories wiped",
        variant: "success",
      });
      await refresh();
    } catch (caught) {
      setError(getSettingsErrorMessage(caught, "Failed to wipe memories."));
    } finally {
      setBusy(null);
    }
  };

  if (!available && !loading) {
    return null;
  }

  const enabled = Boolean(status?.enabled);
  const running = Boolean(status?.running);
  const fps = status?.fps;
  const lastCaptureAt = status?.lastCaptureAt ?? null;

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Memory</h3>
      <p className="settings-card-desc">
        Stella can remember what you've been working on so it can be more
        helpful over time. Everything stays on your computer.
      </p>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Screen memory</div>
          <div className="settings-row-sublabel">
            Lets Stella glance at your screen now and then so it can remember
            what you were doing.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            disabled={busy !== null || loading}
            onClick={() => handleToggle(!enabled)}
          >
            {busy === "toggle" ? "Working…" : enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Status</div>
          <div className="settings-row-sublabel">
            {loading
              ? "Loading…"
              : enabled
                ? `${running ? "Running" : "Stopped"}${
                    typeof fps === "number" ? ` · ${fps.toFixed(2)} fps` : ""
                  }${
                    lastCaptureAt
                      ? ` · last capture ${new Date(lastCaptureAt).toLocaleTimeString()}`
                      : ""
                  }`
                : "Disabled"}
          </div>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Memory folder</div>
          <div className="settings-row-sublabel">
            Open the folder on your computer where Stella keeps its memories.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            disabled={busy !== null}
            onClick={handleOpenFolder}
          >
            {busy === "open" ? "Opening…" : "Open folder"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Update memory now</div>
          <div className="settings-row-sublabel">
            Have Stella review recent activity and save what it learned. This
            usually happens on its own.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            disabled={busy !== null}
            onClick={handleDreamNow}
          >
            {busy === "dream" ? "Dreaming…" : "Run now"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Erase memory</div>
          <div className="settings-row-sublabel">
            Delete everything Stella has remembered, including saved screen
            activity. This can't be undone.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn settings-btn--danger"
            disabled={busy !== null}
            onClick={handleWipe}
          >
            {busy === "wipe" ? "Wiping…" : "Wipe"}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-sublabel settings-card-desc--error">
              {error}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models Tab
// ---------------------------------------------------------------------------

function ModelConfigSection() {
  const [modelPreferences, setModelPreferences] =
    useState<LocalModelPreferences | null>(null);
  const { models: stellaModels } = useModelCatalog();
  const modelDefaults = useMemo<ModelDefaultEntry[] | undefined>(() => {
    if (!modelPreferences) return undefined;
    return getLocalModelDefaults(
      modelPreferences.defaultModels,
      modelPreferences.resolvedDefaultModels,
    );
  }, [modelPreferences]);
  const modelNamesById = useMemo(() => {
    const next = new Map<string, string>();
    for (const model of stellaModels) {
      next.set(model.id, model.name);
      if (model.upstreamModel) {
        next.set(model.upstreamModel, model.name);
      }
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
  const configurableAgents = useMemo(
    () => getConfigurableAgents(modelDefaults),
    [modelDefaults],
  );

  const serverOverrides = useMemo<Record<string, string>>(() => {
    if (!modelPreferences) {
      return {};
    }
    return normalizeModelOverrides(
      modelPreferences.modelOverrides,
      defaultModelMap,
    );
  }, [defaultModelMap, modelPreferences]);
  const [localOverrides, setLocalOverrides] = useState<
    Record<string, string | null>
  >({});
  const [customModelDrafts, setCustomModelDrafts] = useState<
    Record<string, string>
  >({});
  const [localGeneralAgentEngine, setLocalGeneralAgentEngine] = useState<
    "default" | "claude_code_local" | null
  >(null);
  const [localMaxAgentConcurrency, setLocalMaxAgentConcurrency] = useState<
    number | null
  >(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [modelConfigError, setModelConfigError] = useState<string | null>(null);
  const [isSavingRuntimePreference, setIsSavingRuntimePreference] =
    useState(false);
  const [isSavingModelPreferences, setIsSavingModelPreferences] =
    useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadPreferences = async () => {
      try {
        const next =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (!cancelled) {
          setModelPreferences(next ?? null);
          setRuntimeError(null);
          setModelConfigError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeError(
            getSettingsErrorMessage(error, "Failed to load model settings."),
          );
        }
      }
    };

    void loadPreferences();
    return () => {
      cancelled = true;
    };
  }, []);

  const runtimePreferencesLoaded = modelPreferences !== null;
  const modelPreferencesLoaded = modelDefaults !== undefined;

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
    (localGeneralAgentEngine !== null &&
    localGeneralAgentEngine !== modelPreferences?.generalAgentEngine
      ? localGeneralAgentEngine
      : null) ??
    modelPreferences?.generalAgentEngine ??
    "default";
  const effectiveMaxAgentConcurrency =
    (localMaxAgentConcurrency !== null &&
    localMaxAgentConcurrency !== modelPreferences?.maxAgentConcurrency
      ? localMaxAgentConcurrency
      : null) ??
    modelPreferences?.maxAgentConcurrency ??
    24;

  const hasAnyOverride = Object.keys(overrides).length > 0;

  const handleChange = useCallback(
    async (agentType: string, value: string) => {
      if (isSavingModelPreferences) {
        return;
      }

      const previousValue = Object.prototype.hasOwnProperty.call(
        localOverrides,
        agentType,
      )
        ? localOverrides[agentType]
        : undefined;

      setModelConfigError(null);
      setIsSavingModelPreferences(true);
      setLocalOverrides((prev) => ({
        ...prev,
        [agentType]: value === "" ? null : value,
      }));

      try {
        const nextOverrides = { ...serverOverrides };
        if (value === "") {
          delete nextOverrides[agentType];
        } else {
          nextOverrides[agentType] = value;
        }
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            modelOverrides: nextOverrides,
          });
        if (saved) {
          setModelPreferences(saved);
          setLocalOverrides((prev) => {
            const next = { ...prev };
            delete next[agentType];
            return next;
          });
        }
      } catch (error) {
        setLocalOverrides((prev) => {
          const next = { ...prev };
          if (previousValue === undefined) {
            delete next[agentType];
          } else {
            next[agentType] = previousValue;
          }
          return next;
        });
        setModelConfigError(
          getSettingsErrorMessage(error, "Failed to update model setting."),
        );
      } finally {
        setIsSavingModelPreferences(false);
      }
    },
    [isSavingModelPreferences, localOverrides, serverOverrides],
  );

  const handleCustomDraftChange = useCallback(
    (agentType: string, value: string) => {
      setCustomModelDrafts((prev) => ({ ...prev, [agentType]: value }));
    },
    [],
  );

  const commitCustomModel = useCallback(
    async (agentType: string, currentValue: string, nextValue: string) => {
      const trimmed = nextValue.trim();
      if (trimmed === currentValue) {
        return;
      }

      if (!trimmed) {
        await handleChange(agentType, "");
        setCustomModelDrafts((prev) => {
          const next = { ...prev };
          delete next[agentType];
          return next;
        });
        return;
      }

      await handleChange(agentType, trimmed);
      setCustomModelDrafts((prev) => ({ ...prev, [agentType]: trimmed }));
    },
    [handleChange],
  );

  const handleResetAll = useCallback(async () => {
    if (isSavingModelPreferences || !hasAnyOverride) {
      return;
    }

    setModelConfigError(null);
    setIsSavingModelPreferences(true);

    const cleared: Record<string, null> = {};
    for (const key of Object.keys(overrides)) {
      cleared[key] = null;
    }
    setLocalOverrides((prev) => ({ ...prev, ...cleared }));
    setCustomModelDrafts({});

    const keys = Object.keys(overrides);
    const previousLocalOverrides = localOverrides;
    try {
      const saved =
        await window.electronAPI?.system?.setLocalModelPreferences?.({
          modelOverrides: {},
        });
      if (saved) {
        setModelPreferences(saved);
        setLocalOverrides({});
      }
    } catch (error) {
      setLocalOverrides((prev) => {
        const next = { ...prev };
        for (const key of keys) {
          if (
            Object.prototype.hasOwnProperty.call(previousLocalOverrides, key)
          ) {
            next[key] = previousLocalOverrides[key] ?? null;
          } else {
            delete next[key];
          }
        }
        return next;
      });
      setModelConfigError(
        getSettingsErrorMessage(error, "Failed to reset model settings."),
      );
    }

    setIsSavingModelPreferences(false);
  }, [hasAnyOverride, isSavingModelPreferences, localOverrides, overrides]);

  const handleAgentEngineChange = useCallback(
    async (_agentType: "general", value: string) => {
      if (isSavingRuntimePreference) {
        return;
      }

      const engine =
        value === "claude_code_local" ? "claude_code_local" : "default";
      const previousValue = localGeneralAgentEngine;

      setRuntimeError(null);
      setIsSavingRuntimePreference(true);
      setLocalGeneralAgentEngine(engine);

      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            generalAgentEngine: engine,
          });
        if (saved) {
          setModelPreferences(saved);
        }
      } catch (error) {
        setLocalGeneralAgentEngine(previousValue);
        setRuntimeError(
          getSettingsErrorMessage(
            error,
            "Failed to update the general agent runtime.",
          ),
        );
      } finally {
        setIsSavingRuntimePreference(false);
      }
    },
    [isSavingRuntimePreference, localGeneralAgentEngine],
  );

  const handleMaxAgentConcurrencyChange = useCallback(
    async (value: string) => {
      if (isSavingRuntimePreference) {
        return;
      }

      const parsed = Number(value);
      const normalized =
        Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 24;
      const previousValue = localMaxAgentConcurrency;

      setRuntimeError(null);
      setIsSavingRuntimePreference(true);
      setLocalMaxAgentConcurrency(normalized);

      try {
        const saved =
          await window.electronAPI?.system?.setLocalModelPreferences?.({
            maxAgentConcurrency: normalized,
          });
        if (saved) {
          setModelPreferences(saved);
        }
      } catch (error) {
        setLocalMaxAgentConcurrency(previousValue);
        setRuntimeError(
          getSettingsErrorMessage(
            error,
            "Failed to update max agent concurrency.",
          ),
        );
      } finally {
        setIsSavingRuntimePreference(false);
      }
    },
    [isSavingRuntimePreference, localMaxAgentConcurrency],
  );

  return (
    <>
      <div className="settings-card">
        <h3 className="settings-card-title">Agents</h3>
        <p className="settings-card-desc">
          Choose how Stella runs background tasks on your computer.
        </p>
        {runtimeError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {runtimeError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Engine</div>
            <div className="settings-row-sublabel">
              Powers Stella's main assistant. Choosing Claude Code requires the{" "}
              <code>claude</code> command installed on your computer.
            </div>
          </div>
          <div className="settings-row-control">
            {runtimePreferencesLoaded ? (
              <NativeSelect
                className="settings-runtime-select"
                value={effectiveGeneralAgentEngine}
                onChange={(e) =>
                  void handleAgentEngineChange("general", e.target.value)
                }
                disabled={isSavingRuntimePreference}
              >
                {GENERAL_AGENT_ENGINE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <NativeSelect
                className="settings-runtime-select"
                value="loading"
                disabled
              >
                <option value="loading">Loading saved setting...</option>
              </NativeSelect>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Max running tasks</div>
            <div className="settings-row-sublabel">
              How many background tasks Stella can run at the same time.
            </div>
          </div>
          <div className="settings-row-control">
            {runtimePreferencesLoaded ? (
              <NativeSelect
                className="settings-runtime-select"
                value={String(effectiveMaxAgentConcurrency)}
                onChange={(e) =>
                  void handleMaxAgentConcurrencyChange(e.target.value)
                }
                disabled={isSavingRuntimePreference}
              >
                {MAX_AGENT_CONCURRENCY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <NativeSelect
                className="settings-runtime-select"
                value="loading"
                disabled
              >
                <option value="loading">Loading saved setting...</option>
              </NativeSelect>
            )}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Models</h3>
          <Button
            type="button"
            variant="ghost"
            className="settings-btn settings-btn--reset-all"
            onClick={() => void handleResetAll()}
            style={{ visibility: hasAnyOverride ? "visible" : "hidden" }}
            disabled={!modelPreferencesLoaded || isSavingModelPreferences}
          >
            {isSavingModelPreferences ? "Resetting..." : "Reset All"}
          </Button>
        </div>
        <p className="settings-card-desc">
          Pick which AI model Stella uses for each kind of task. Leave on
          Default for our recommendation.
        </p>
        {modelConfigError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {modelConfigError}
          </p>
        ) : null}
        {!modelPreferencesLoaded ? (
          <p className="settings-card-desc">Loading saved settings...</p>
        ) : null}
        {modelPreferencesLoaded &&
          configurableAgents.map((agent) => {
            const current = overrides[agent.key] ?? "";
            const isDirectOverride =
              Boolean(current) && !isStellaSelection(current);
            const isCustomEditing = Object.prototype.hasOwnProperty.call(
              customModelDrafts,
              agent.key,
            );
            const selectValue =
              isDirectOverride || isCustomEditing ? "__custom__" : current;
            const customDraft =
              customModelDrafts[agent.key] ?? (isDirectOverride ? current : "");
            const selectedStellaModel =
              isStellaSelection(current) &&
              current !== STELLA_DEFAULT_MODEL &&
              !stellaModels.some((model) => model.id === current)
                ? current
                : null;
            const defaultLabel = getDefaultModelOptionLabel(
              agent.key,
              defaultModelMap,
              resolvedDefaultModelMap,
              modelNamesById,
            );
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
                      onClick={() => {
                        setCustomModelDrafts((prev) => {
                          const next = { ...prev };
                          delete next[agent.key];
                          return next;
                        });
                        void handleChange(agent.key, "");
                      }}
                      title="Reset to default"
                      disabled={isSavingModelPreferences}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12a9 9 0 1 1 3 6.7" />
                        <polyline points="3 7 3 13 9 13" />
                      </svg>
                    </button>
                  )}
                  <NativeSelect
                    className="settings-model-select"
                    value={selectValue}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === "__custom__") {
                        setCustomModelDrafts((prev) => ({
                          ...prev,
                          [agent.key]: current,
                        }));
                        return;
                      }
                      setCustomModelDrafts((prev) => {
                        const next = { ...prev };
                        delete next[agent.key];
                        return next;
                      });
                      void handleChange(agent.key, value);
                    }}
                    disabled={isSavingModelPreferences}
                  >
                    <option value="">{defaultLabel}</option>
                    {selectedStellaModel ? (
                      <option value={selectedStellaModel}>
                        {modelNamesById.get(selectedStellaModel) ??
                          selectedStellaModel}
                      </option>
                    ) : null}
                    {stellaModels
                      .filter((model) => model.id !== STELLA_DEFAULT_MODEL)
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    <option value="__custom__">Custom model ID…</option>
                  </NativeSelect>
                  {selectValue === "__custom__" ? (
                    <div className="settings-model-input">
                      <TextField
                        label={`${agent.label} custom model`}
                        hideLabel={true}
                        placeholder="anthropic/claude-opus-4.6"
                        value={customDraft}
                        onChange={(e) =>
                          handleCustomDraftChange(agent.key, e.target.value)
                        }
                        onBlur={(e) =>
                          void commitCustomModel(
                            agent.key,
                            current,
                            e.currentTarget.value,
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          }
                          if (e.key === "Escape") {
                            setCustomModelDrafts((prev) => ({
                              ...prev,
                              [agent.key]: isDirectOverride ? current : "",
                            }));
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    </div>
                  ) : null}
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
  const [llmCredentials, setLlmCredentials] = useState<
    LocalLlmCredentialSummary[]
  >([]);
  const [oauthProviders, setOauthProviders] = useState<
    LocalLlmOAuthProviderSummary[]
  >([]);
  const [oauthCredentials, setOauthCredentials] = useState<
    LocalLlmCredentialSummary[]
  >([]);
  const [useLocalKeys, setUseLocalKeys] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [oauthProviderInFlight, setOauthProviderInFlight] = useState<
    string | null
  >(null);
  const [isSavingRoutingPreference, setIsSavingRoutingPreference] =
    useState(false);
  const [removingProvider, setRemovingProvider] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    if (!window.electronAPI?.system.listLlmCredentials) {
      setLlmCredentials([]);
      return;
    }

    const nextCredentials =
      await window.electronAPI.system.listLlmCredentials();
    setLlmCredentials(nextCredentials);
  }, []);

  const loadOauthCredentials = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (
      !systemApi?.listLlmOAuthProviders ||
      !systemApi.listLlmOAuthCredentials
    ) {
      setOauthProviders([]);
      setOauthCredentials([]);
      return;
    }

    const [nextProviders, nextCredentials] = await Promise.all([
      systemApi.listLlmOAuthProviders(),
      systemApi.listLlmOAuthCredentials(),
    ]);
    setOauthProviders(nextProviders);
    setOauthCredentials(nextCredentials);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        await loadCredentials();
        await loadOauthCredentials();
        const routingPreference =
          await window.electronAPI?.system.getLlmCredentialRoutingPreference?.();
        if (!cancelled) {
          if (routingPreference) {
            setUseLocalKeys(routingPreference.enabled);
            setSelectedProvider(routingPreference.provider || "openai");
          }
          setCredentialsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCredentialsError(
            error instanceof Error
              ? error.message
              : "Failed to load local API keys.",
          );
          setLlmCredentials([]);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [loadCredentials, loadOauthCredentials]);

  const getCredentialForProvider = (providerKey: string) =>
    llmCredentials.find(
      (credential) =>
        credential.provider === providerKey && credential.status === "active",
    );

  const getOauthProviderForProvider = (providerKey: string) =>
    oauthProviders.find((provider) => provider.provider === providerKey);

  const getOauthCredentialForProvider = (providerKey: string) =>
    oauthCredentials.find(
      (credential) =>
        credential.provider === providerKey && credential.status === "active",
    );

  const saveRoutingPreference = useCallback(
    async (next: { enabled: boolean; provider: string }) => {
      if (!window.electronAPI?.system.setLlmCredentialRoutingPreference) {
        setCredentialsError(
          "Local API key settings are unavailable in this window.",
        );
        return;
      }

      const previous = {
        enabled: useLocalKeys,
        provider: selectedProvider,
      };
      setUseLocalKeys(next.enabled);
      setSelectedProvider(next.provider);
      setCredentialsError(null);
      setIsSavingRoutingPreference(true);
      try {
        const saved =
          await window.electronAPI.system.setLlmCredentialRoutingPreference(
            next,
          );
        setUseLocalKeys(saved.enabled);
        setSelectedProvider(saved.provider || "openai");
      } catch (error) {
        setUseLocalKeys(previous.enabled);
        setSelectedProvider(previous.provider);
        setCredentialsError(
          error instanceof Error
            ? error.message
            : "Failed to update local API key settings.",
        );
      } finally {
        setIsSavingRoutingPreference(false);
      }
    },
    [selectedProvider, useLocalKeys],
  );

  const handleSave = useCallback(
    async (providerKey: string, label: string) => {
      if (!keyInput.trim()) return;
      if (!window.electronAPI?.system.saveLlmCredential) {
        setCredentialsError(
          "Local API key storage is unavailable in this window.",
        );
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
          const next = prev.filter(
            (entry) => entry.provider !== saved.provider,
          );
          next.push(saved);
          return next.sort((a, b) => a.label.localeCompare(b.label));
        });
        setKeyInput("");
        setEditingProvider(null);
      } catch (error) {
        setCredentialsError(
          error instanceof Error
            ? error.message
            : "Failed to save local API key.",
        );
      } finally {
        setIsSavingKey(false);
      }
    },
    [keyInput],
  );

  const handleRemove = useCallback(async (providerKey: string) => {
    if (!window.electronAPI?.system.deleteLlmCredential) {
      setCredentialsError(
        "Local API key storage is unavailable in this window.",
      );
      return;
    }
    setCredentialsError(null);
    setRemovingProvider(providerKey);
    try {
      await window.electronAPI.system.deleteLlmCredential(providerKey);
      setLlmCredentials((prev) =>
        prev.filter((entry) => entry.provider !== providerKey),
      );
    } catch (error) {
      setCredentialsError(
        error instanceof Error
          ? error.message
          : "Failed to remove local API key.",
      );
    } finally {
      setRemovingProvider(null);
    }
  }, []);

  const handleOauthLogin = useCallback(async (providerKey: string) => {
    if (!window.electronAPI?.system.loginLlmOAuthCredential) {
      setCredentialsError("OAuth login is unavailable in this window.");
      return;
    }
    setCredentialsError(null);
    setOauthProviderInFlight(providerKey);
    try {
      const saved =
        await window.electronAPI.system.loginLlmOAuthCredential(providerKey);
      setOauthCredentials((prev) => {
        const next = prev.filter((entry) => entry.provider !== saved.provider);
        next.push(saved);
        return next.sort((a, b) => a.label.localeCompare(b.label));
      });
    } catch (error) {
      setCredentialsError(
        error instanceof Error ? error.message : "OAuth login failed.",
      );
    } finally {
      setOauthProviderInFlight(null);
    }
  }, []);

  const handleOauthRemove = useCallback(async (providerKey: string) => {
    if (!window.electronAPI?.system.deleteLlmOAuthCredential) {
      setCredentialsError("OAuth login is unavailable in this window.");
      return;
    }
    setCredentialsError(null);
    setOauthProviderInFlight(providerKey);
    try {
      await window.electronAPI.system.deleteLlmOAuthCredential(providerKey);
      setOauthCredentials((prev) =>
        prev.filter((entry) => entry.provider !== providerKey),
      );
    } catch (error) {
      setCredentialsError(
        error instanceof Error
          ? error.message
          : "Failed to remove OAuth login.",
      );
    } finally {
      setOauthProviderInFlight(null);
    }
  }, []);

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">API keys &amp; OAuth</h3>
      <p className="settings-card-desc">
        Add your own API keys. Talk to your providers directly. Keys stay on
        this device.
      </p>
      {credentialsError ? (
        <p className="settings-card-desc">{credentialsError}</p>
      ) : null}
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            Sign in to another provider or use my API key
          </div>
          <div className="settings-row-sublabel">
            Use Anthropic, OpenAI, and other providers directly. When off,
            Stella uses its built-in access.
          </div>
        </div>
        <div className="settings-row-control">
          <Switch
            checked={useLocalKeys}
            disabled={isSavingRoutingPreference}
            onCheckedChange={(checked) =>
              void saveRoutingPreference({
                enabled: checked,
                provider: selectedProvider,
              })
            }
            hideLabel
          />
        </div>
      </div>
      {useLocalKeys ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Provider</div>
            <div className="settings-row-sublabel">
              Which provider Stella routes through.
            </div>
          </div>
          <div className="settings-row-control">
            <NativeSelect
              className="settings-model-select"
              value={selectedProvider}
              disabled={isSavingRoutingPreference}
              onChange={(event) =>
                void saveRoutingPreference({
                  enabled: useLocalKeys,
                  provider: event.currentTarget.value,
                })
              }
            >
              {LLM_PROVIDERS.map((provider) => (
                <option key={provider.key} value={provider.key}>
                  {provider.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      ) : null}
      {useLocalKeys &&
        LLM_PROVIDERS.map((provider) => {
          const credential = getCredentialForProvider(provider.key);
          const oauthProvider = getOauthProviderForProvider(provider.key);
          const oauthCredential = getOauthCredentialForProvider(provider.key);
          const isEditing = editingProvider === provider.key;
          const isRemoving = removingProvider === provider.key;
          const isOauthBusy = oauthProviderInFlight === provider.key;
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
                  {oauthCredential ? (
                    <span className="settings-key-status">
                      <span className="settings-key-dot settings-key-dot--active" />
                      Signed in
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="settings-row-control">
                {isEditing ? (
                  <div className="settings-key-input">
                    <TextField
                      label={`${provider.label} API key`}
                      hideLabel={true}
                      type="password"
                      placeholder={provider.placeholder}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          handleSave(provider.key, provider.label);
                        if (e.key === "Escape") {
                          setEditingProvider(null);
                          setKeyInput("");
                        }
                      }}
                      autoFocus
                    />
                    <Button
                      type="button"
                      variant="primary"
                      className="settings-btn settings-btn--primary"
                      onClick={() => handleSave(provider.key, provider.label)}
                      disabled={isSavingKey}
                    >
                      {isSavingKey ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="settings-btn"
                      onClick={() => {
                        setEditingProvider(null);
                        setKeyInput("");
                      }}
                      disabled={isSavingKey}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      className="settings-btn"
                      onClick={() => {
                        setEditingProvider(provider.key);
                        setKeyInput("");
                        setCredentialsError(null);
                      }}
                      disabled={isSavingKey || Boolean(removingProvider)}
                    >
                      {credential ? "Update key" : "Add key"}
                    </Button>
                    {credential && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="settings-btn settings-btn--danger"
                        onClick={() => handleRemove(provider.key)}
                        disabled={isRemoving || isSavingKey}
                      >
                        {isRemoving ? "Removing..." : "Remove"}
                      </Button>
                    )}
                    {oauthProvider ? (
                      oauthCredential ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="settings-btn settings-btn--danger"
                          onClick={() => handleOauthRemove(provider.key)}
                          disabled={isOauthBusy || isSavingKey}
                        >
                          {isOauthBusy ? "Signing out..." : "Sign out"}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          className="settings-btn"
                          onClick={() => handleOauthLogin(provider.key)}
                          disabled={isOauthBusy || isSavingKey}
                        >
                          {isOauthBusy ? "Opening..." : "Sign in"}
                        </Button>
                      )
                    ) : null}
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
// SettingsScreen (route-mounted, no Dialog wrapper)
// ---------------------------------------------------------------------------

export type { SettingsTab };

export interface SettingsScreenProps {
  /** Tab currently in view. When omitted, defaults to basic. */
  activeTab?: SettingsTab;
  /** Called when the user clicks a different tab in the sidebar. */
  onActiveTabChange?: (tab: SettingsTab) => void;
  /** Called when the user signs out from the Basic tab. */
  onSignOut?: () => void;
}

/**
 * The settings UI rendered inline (no Dialog wrapper). Mounted by the
 * `/settings` route. Tab state can be controlled (via `?tab=...`) or
 * uncontrolled.
 */
export const SettingsScreen = ({
  activeTab: activeTabProp,
  onActiveTabChange,
  onSignOut,
}: SettingsScreenProps) => {
  const [selectedTab, setSelectedTab] = useState<SettingsTab>("basic");
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(
    null,
  );

  const activeTab = activeTabProp ?? selectedTab;

  const handleTabClick = useCallback(
    (next: SettingsTab) => {
      if (activeTabProp === undefined) {
        setSelectedTab(next);
      }
      onActiveTabChange?.(next);
    },
    [activeTabProp, onActiveTabChange],
  );

  return (
    <>
      {/* The Settings tabs live in the *main* sidebar via <PageSidebar>:
          while /settings is mounted, the shell swaps its default nav for
          this tab list (and prepends a Back button automatically). The
          screen body itself is single-column. */}
      <PageSidebar title="Settings">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`sidebar-nav-item${activeTab === tab.key ? " sidebar-nav-item--active" : ""}`}
            onClick={() => handleTabClick(tab.key)}
          >
            <span className="sidebar-nav-label">{tab.label}</span>
          </button>
        ))}
      </PageSidebar>
      <div className="settings-screen">
        <div className="settings-layout settings-layout--single">
          <SettingsPanel>
            {activeTab === "basic" ? (
              <BasicSettingsTab />
            ) : activeTab === "shortcuts" ? (
              <ShortcutsSettingsTab />
            ) : activeTab === "memory" ? (
              <div className="settings-tab-content">
                <ChronicleSettingsCard />
              </div>
            ) : activeTab === "backup" ? (
              <BackupSettingsTab />
            ) : activeTab === "account" ? (
              <AccountSettingsTab
                onSignOut={onSignOut}
                onOpenLegal={setActiveLegalDoc}
              />
            ) : activeTab === "models" ? (
              <ModelsTab />
            ) : (
              <AudioTab />
            )}
          </SettingsPanel>
        </div>
      </div>
      <Suspense fallback={null}>
        <LegalDialog
          document={activeLegalDoc}
          onOpenChange={(open) => {
            if (!open) setActiveLegalDoc(null);
          }}
        />
      </Suspense>
    </>
  );
};

export default SettingsScreen;
