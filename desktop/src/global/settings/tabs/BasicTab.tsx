import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { LanguageSettingsRow } from "@/global/settings/LanguageSettingsRow";
import {
  useDesktopPermissions,
  type DesktopPermissionStatus,
} from "@/global/permissions/use-desktop-permissions";
import { requestBrowserMicrophoneAccess } from "@/global/permissions/microphone-permission";
import {
  setDeveloperResourcePreviewsEnabled,
  useDeveloperResourcePreviewsEnabled,
} from "@/shared/lib/developer-resource-previews";
import { openExternalUrl } from "@/platform/electron/open-external";
import { SourceDiffEndResource } from "@/app/chat/EndResourceCard";
import {
  pushAndOpenSourceDiffBatch,
} from "@/shell/display/source-diff-batches";
import { createSourceDiffTabSpec } from "@/shell/display/payload-to-tab-spec";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import {
  DEFAULT_PERSONALITY_VOICE_ID,
  PERSONALITY_VOICES,
} from "../../../../../runtime/extensions/stella-runtime/personality/voices.js";
import { getSettingsErrorMessage } from "./shared";

const SETTINGS_PERMISSION_RESTART_KINDS = ["screen"] as const;
const STELLA_CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/kfnchfpocpmdblhfgcnpfaaebaioojnl?utm_source=item-share-cb";

const DEV_PREVIEW_DEMO_PATCH = `*** Update File: src/app/chat/lib/derive-turn-resource.ts
@@ buildPayloadFromBarePath
     default:
       if (
         options?.developerResourcesEnabled === true &&
         isDeveloperResourceExtension(extensionOf(filePath))
       ) {
         return {
           kind: "source-diff",
           filePath,
           title: basenameOf(filePath),
-          ...(options.patch ? { patch: options.patch } : {}),
+          ...(options.patch ? { patch: options.patch } : {}),
+          // Surface developer-resource diffs even when the turn
+          // touched several files at once.
           createdAt,
         };
       }
*** Update File: src/shell/display/tab-content.tsx
@@ SourceDiffTabContent
-  const sections = useMemo(() => {
-    if (patch?.trim()) {
-      const parsed = parseApplyPatchPreview(patch);
-      if (parsed.length > 0) return parsed;
-    }
-    if (!bytes) return [];
-    return buildGeneratedFilePreview(filePath, fileText);
-  }, [bytes, filePath, fileText, patch]);
+  const parsedPatchSections = useMemo(() => {
+    if (!patch?.trim()) return null;
+    const parsed = parseApplyPatchPreview(patch);
+    return parsed.length > 0 ? parsed : null;
+  }, [patch]);
+  const sections = useMemo(() => {
+    if (parsedPatchSections) return parsedPatchSections;
+    if (!bytes) return [];
+    return buildGeneratedFilePreview(filePath, fileText);
+  }, [bytes, filePath, fileText, parsedPatchSections]);
*** Add File: src/shell/display/demo-source-diff.ts
+export const DEMO_SOURCE_DIFF_FILE_PATH =
+  "src/app/chat/lib/derive-turn-resource.ts";
+
+export const DEMO_SOURCE_DIFF_TITLE = "derive-turn-resource.ts";
`;

const DEV_PREVIEW_SECONDARY_PATCH = `*** Update File: src/app/chat/EndResourceCard.tsx
@@ SourceDiffEndResource
-    return (
-      <button className="end-resource-card">
-        …
-      </button>
-    );
+    return (
+      <button className="end-resource-card" onClick={handleClick}>
+        {sourceDiffPayloads.length} file changes
+      </button>
+    );
`;

const DEV_PREVIEW_DEMO_PAYLOAD_PRIMARY: DisplayPayload = {
  kind: "source-diff",
  filePath: "src/app/chat/lib/derive-turn-resource.ts",
  title: "derive-turn-resource.ts",
  patch: DEV_PREVIEW_DEMO_PATCH,
  createdAt: Date.now(),
};

const DEV_PREVIEW_DEMO_PAYLOAD_SECONDARY: DisplayPayload = {
  kind: "source-diff",
  filePath: "src/app/chat/EndResourceCard.tsx",
  title: "EndResourceCard.tsx",
  patch: DEV_PREVIEW_SECONDARY_PATCH,
  createdAt: Date.now(),
};

const DEV_PREVIEW_SINGLE_PAYLOADS: DisplayPayload[] = [
  DEV_PREVIEW_DEMO_PAYLOAD_PRIMARY,
];

const DEV_PREVIEW_MULTI_PAYLOADS: DisplayPayload[] = [
  DEV_PREVIEW_DEMO_PAYLOAD_PRIMARY,
  DEV_PREVIEW_DEMO_PAYLOAD_SECONDARY,
  {
    kind: "source-diff",
    filePath: "src/shell/display/tab-content.tsx",
    title: "tab-content.tsx",
    createdAt: Date.now(),
  },
];

export function BasicTab() {
  const platform = window.electronAPI?.platform;
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const [preventComputerSleep, setPreventComputerSleep] = useState(false);
  const [preventSleepLoaded, setPreventSleepLoaded] = useState(false);
  const [isSavingPreventSleep, setIsSavingPreventSleep] = useState(false);
  const [preventSleepError, setPreventSleepError] = useState<string | null>(
    null,
  );
  const [soundNotificationsEnabled, setSoundNotificationsEnabled] =
    useState(true);
  const [soundNotificationsLoaded, setSoundNotificationsLoaded] =
    useState(false);
  const [isSavingSoundNotifications, setIsSavingSoundNotifications] =
    useState(false);
  const [soundNotificationsError, setSoundNotificationsError] = useState<
    string | null
  >(null);
  const [personalityVoiceId, setPersonalityVoiceIdState] = useState<string>(
    DEFAULT_PERSONALITY_VOICE_ID,
  );
  const [personalityVoiceLoaded, setPersonalityVoiceLoaded] = useState(false);
  const [isSavingPersonalityVoice, setIsSavingPersonalityVoice] =
    useState(false);
  const [personalityVoiceError, setPersonalityVoiceError] = useState<
    string | null
  >(null);
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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const enabled =
          await window.electronAPI?.system?.getSoundNotificationsEnabled?.();
        if (!cancelled) {
          setSoundNotificationsEnabled(enabled !== false);
          setSoundNotificationsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setSoundNotificationsError(
            getSettingsErrorMessage(
              error,
              "Failed to load sound notification setting.",
            ),
          );
        }
      } finally {
        if (!cancelled) setSoundNotificationsLoaded(true);
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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const current =
          await window.electronAPI?.system?.getPersonalityVoice?.();
        if (!cancelled) {
          setPersonalityVoiceIdState(
            typeof current === "string" && current.trim().length > 0
              ? current
              : DEFAULT_PERSONALITY_VOICE_ID,
          );
          setPersonalityVoiceError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setPersonalityVoiceError(
            getSettingsErrorMessage(error, "Failed to load voice setting."),
          );
        }
      } finally {
        if (!cancelled) setPersonalityVoiceLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePersonalityVoiceChange = useCallback(
    async (nextVoiceId: string) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setPersonalityVoice) {
        setPersonalityVoiceError(
          "Voice settings are unavailable in this window.",
        );
        return;
      }
      const previous = personalityVoiceId;
      setPersonalityVoiceIdState(nextVoiceId);
      setPersonalityVoiceError(null);
      setIsSavingPersonalityVoice(true);
      try {
        const result = await systemApi.setPersonalityVoice(nextVoiceId);
        if (typeof result?.voiceId === "string" && result.voiceId.length > 0) {
          setPersonalityVoiceIdState(result.voiceId);
        }
      } catch (error) {
        setPersonalityVoiceIdState(previous);
        setPersonalityVoiceError(
          getSettingsErrorMessage(error, "Failed to update voice setting."),
        );
      } finally {
        setIsSavingPersonalityVoice(false);
      }
    },
    [personalityVoiceId],
  );

  const handleSoundNotificationsChange = useCallback(
    async (checked: boolean) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setSoundNotificationsEnabled) {
        setSoundNotificationsError(
          "Sound notification settings are unavailable in this window.",
        );
        return;
      }

      const previous = soundNotificationsEnabled;
      setSoundNotificationsEnabled(checked);
      setSoundNotificationsError(null);
      setIsSavingSoundNotifications(true);
      try {
        const result = await systemApi.setSoundNotificationsEnabled(checked);
        setSoundNotificationsEnabled(result.enabled);
      } catch (error) {
        setSoundNotificationsEnabled(previous);
        setSoundNotificationsError(
          getSettingsErrorMessage(
            error,
            "Failed to update sound notification setting.",
          ),
        );
      } finally {
        setIsSavingSoundNotifications(false);
      }
    },
    [soundNotificationsEnabled],
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
    refresh: refreshPermissions,
    requestWithSettingsFallback,
    restart: restartAfterPermissionChange,
  } = useDesktopPermissions({
    enabled: platform === "darwin",
    pollMs: 1500,
    initialStatus: initialPermissionStatus,
    restartKinds: SETTINGS_PERMISSION_RESTART_KINDS,
    errorMessage: formatPermissionLoadError,
  });

  const [requestingMicrophonePermission, setRequestingMicrophonePermission] =
    useState(false);

  const requestMicrophonePermission = useCallback(async () => {
    setRequestingMicrophonePermission(true);
    try {
      const latestStatus = await refreshPermissions();
      if (latestStatus.microphone) return;

      if (latestStatus.microphoneStatus === "denied") {
        await window.electronAPI?.system.openPermissionSettings?.("microphone");
        throw new Error(
          "Microphone access was denied earlier. Turn it on in System Settings, then reopen Stella.",
        );
      }

      await requestBrowserMicrophoneAccess();

      const nextStatus = await refreshPermissions();
      if (!nextStatus.microphone) {
        throw new Error(
          "Microphone access is still off. Turn it on in System Settings, then reopen Stella.",
        );
      }
    } finally {
      setRequestingMicrophonePermission(false);
    }
  }, [refreshPermissions]);

  const handlePermissionEnable = useCallback(
    async (kind: "accessibility" | "screen" | "microphone") => {
      setPermissionsError(null);
      try {
        if (kind === "microphone") {
          await requestMicrophonePermission();
        } else {
          await requestWithSettingsFallback(kind);
        }
      } catch (error) {
        setPermissionsError(
          getSettingsErrorMessage(
            error,
            `Failed to update ${kind} permission.`,
          ),
        );
      }
    },
    [
      requestMicrophonePermission,
      requestWithSettingsFallback,
      setPermissionsError,
    ],
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
      <LanguageSettingsRow />
      <div className="settings-card">
        <h3 className="settings-card-title">Chat previews</h3>
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
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Preview</div>
            <div className="settings-row-sublabel">
              Force-enable the feature, push two sample batches into the
              singleton "Code changes" tab, and surface the same inline
              card you'd see at the end of an assistant turn.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              onClick={() => {
                setDeveloperResourcePreviewsEnabled(true);
                pushAndOpenSourceDiffBatch(
                  {
                    id: "settings-preview:single",
                    createdAt: Date.now(),
                    payloads: DEV_PREVIEW_SINGLE_PAYLOADS,
                  },
                  createSourceDiffTabSpec(),
                );
                pushAndOpenSourceDiffBatch(
                  {
                    id: "settings-preview:multi",
                    createdAt: Date.now(),
                    payloads: DEV_PREVIEW_MULTI_PAYLOADS,
                  },
                  createSourceDiffTabSpec(),
                );
              }}
            >
              Show sample
            </Button>
          </div>
        </div>
        <div className="settings-row" style={{ display: "block" }}>
          <div
            className="settings-row-label"
            style={{ marginBottom: 8 }}
          >
            Single file (inline link)
          </div>
          <SourceDiffEndResource
            batchId="settings-preview:single"
            payloads={DEV_PREVIEW_SINGLE_PAYLOADS}
          />
        </div>
        <div className="settings-row" style={{ display: "block" }}>
          <div
            className="settings-row-label"
            style={{ marginBottom: 8 }}
          >
            Multiple files (summary card)
          </div>
          <SourceDiffEndResource
            batchId="settings-preview:multi"
            payloads={DEV_PREVIEW_MULTI_PAYLOADS}
          />
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Voice</h3>
        {personalityVoiceError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {personalityVoiceError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Personality</div>
            <div className="settings-row-sublabel">
              {PERSONALITY_VOICES.find(
                (voice) => voice.id === personalityVoiceId,
              )?.description ?? ""}
            </div>
          </div>
          <div className="settings-row-control">
            <Select
              className="settings-runtime-select"
              value={personalityVoiceId}
              disabled={!personalityVoiceLoaded || isSavingPersonalityVoice}
              aria-label="Personality"
              onValueChange={(value) =>
                void handlePersonalityVoiceChange(value)
              }
              options={PERSONALITY_VOICES.map((voice) => ({
                value: voice.id,
                label: voice.label,
              }))}
            />
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Notifications</h3>
        {soundNotificationsError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {soundNotificationsError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Sound notifications</div>
            <div className="settings-row-sublabel">
              Play a sound when Stella finishes an agent run.
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={soundNotificationsEnabled}
              disabled={!soundNotificationsLoaded || isSavingSoundNotifications}
              onCheckedChange={(checked) =>
                void handleSoundNotificationsChange(Boolean(checked))
              }
              hideLabel
            />
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h3 className="settings-card-title">Power</h3>
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
      <div className="settings-card">
        <h3 className="settings-card-title">Browser extension</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Stella for Chrome</div>
            <div className="settings-row-sublabel">
              Lets Stella see the page you're on and take actions in your
              browser.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => openExternalUrl(STELLA_CHROME_EXTENSION_URL)}
            >
              Get extension
            </Button>
          </div>
        </div>
      </div>
      {platform === "darwin" ? (
        <div className="settings-card">
          <h3 className="settings-card-title">Permissions</h3>
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
                disabled={
                  !permissionsLoaded ||
                  permissionStatus.microphone ||
                  requestingMicrophonePermission
                }
                onClick={() => void handlePermissionEnable("microphone")}
              >
                {permissionStatus.microphone
                  ? "Granted"
                  : requestingMicrophonePermission
                    ? "Opening..."
                    : "Enable"}
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
