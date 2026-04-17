import {
  lazy,
  Suspense,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";
import {
  buildModelDefaultsMap,
  buildResolvedModelDefaultsMap,
  getConfigurableAgents,
  getDefaultModelOptionLabel,
  normalizeModelOverrides,
  type ModelDefaultEntry,
} from "@/global/settings/lib/model-defaults";
import { showToast } from "@/ui/toast";
import type {
  BackupStatusSnapshot,
  BackupSummary,
  LocalLlmCredentialSummary,
} from "@/shared/types/electron";
import type { LegalDocument } from "@/global/legal/legal-text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { NativeSelect } from "@/ui/native-select";
import { BillingTab } from "@/global/settings/BillingTab";
import { AudioTab } from "@/global/settings/AudioTab";
import { ConnectionsTab } from "@/global/settings/ConnectionsTab";
import { hasBillingCheckoutCompletionMarker } from "@/global/settings/lib/billing-checkout";
import "@/global/settings/settings.css";

const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({
    default: m.LegalDialog,
  })),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsTab = "basic" | "models" | "audio" | "billing" | "connections";

type BasicTabPermissionStatus = {
  accessibility: boolean;
  screen: boolean;
  microphone: boolean;
  microphoneStatus:
    | "not-determined"
    | "granted"
    | "denied"
    | "restricted"
    | "unknown";
};

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERAL_AGENT_ENGINE_OPTIONS = [
  { id: "default", name: "Stella" },
  { id: "claude_code_local", name: "Claude Code" },
] as const;

const MAX_AGENT_CONCURRENCY_OPTIONS = Array.from(
  { length: 24 },
  (_, index) => index + 1,
);

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
] as const;

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "basic", label: "Basic" },
  { key: "models", label: "Models" },
  { key: "audio", label: "Audio" },
  { key: "connections", label: "Connections" },
  { key: "billing", label: "Billing" },
];

function getSettingsErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
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

// ---------------------------------------------------------------------------
// Basic Tab
// ---------------------------------------------------------------------------

function BasicTab({
  onSignOut,
  onOpenLegal,
}: {
  onSignOut?: () => void;
  onOpenLegal?: (doc: LegalDocument) => void;
}) {
  const { hasConnectedAccount } = useAuthSessionState();
  const platform = window.electronAPI?.platform;
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
  const [permissionStatus, setPermissionStatus] =
    useState<BasicTabPermissionStatus>({
      accessibility: platform === "darwin" ? false : true,
      screen: platform === "darwin" ? false : true,
      microphone: platform === "darwin" ? false : true,
      microphoneStatus: platform === "darwin" ? "unknown" : "granted",
    });
  const lastPermissionStatusRef = useRef<BasicTabPermissionStatus | null>(null);
  const [permissionsLoaded, setPermissionsLoaded] = useState(platform !== "darwin");
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const [activePermissionAction, setActivePermissionAction] = useState<
    "accessibility" | "screen" | null
  >(null);
  const [isRestartingAfterPermissions, setIsRestartingAfterPermissions] =
    useState(false);
  const [screenRestartRecommended, setScreenRestartRecommended] = useState(false);

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
    const nextSyncMode = (await systemApi.getLocalSyncMode()) === "on" ? "on" : "off";
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

  const fetchPermissionStatus = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.getPermissionStatus) {
      const fallbackStatus: BasicTabPermissionStatus = {
        accessibility: true,
        screen: true,
        microphone: true,
        microphoneStatus: "granted",
      };
      setPermissionStatus(fallbackStatus);
      return fallbackStatus;
    }

    const nextStatus = await systemApi.getPermissionStatus();
    const previousStatus = lastPermissionStatusRef.current;
    if (previousStatus && !previousStatus.screen && nextStatus.screen) {
      setScreenRestartRecommended(true);
    }
    lastPermissionStatusRef.current = nextStatus;
    setPermissionStatus(nextStatus);
    return nextStatus;
  }, []);

  useEffect(() => {
    if (platform !== "darwin") {
      return;
    }

    let cancelled = false;
    const loadPermissions = async () => {
      try {
        const nextStatus = await fetchPermissionStatus();
        if (!cancelled) {
          setPermissionsError(null);
          setPermissionStatus(nextStatus);
        }
      } catch (error) {
        if (!cancelled) {
          setPermissionsError(
            getSettingsErrorMessage(
              error,
              "Failed to load desktop permission status.",
            ),
          );
        }
      } finally {
        if (!cancelled) {
          setPermissionsLoaded(true);
        }
      }
    };

    void loadPermissions();
    const intervalId = window.setInterval(() => {
      void loadPermissions();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [fetchPermissionStatus, platform]);


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
      setBackupError(null);
      setSyncMode(nextMode);
      setIsSavingSyncMode(true);
      try {
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
    [isSavingSyncMode, loadBackupState, syncMode],
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

  const handleRestoreBackup = useCallback(
    async (snapshotId: string) => {
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
        const message = getSettingsErrorMessage(error, "Failed to restore backup.");
        setBackupError(message);
        showToast({
          title: "Restore failed",
          description: message,
          variant: "error",
        });
      } finally {
        setRestoringSnapshotId(null);
      }
    },
    [],
  );

  const handlePermissionEnable = useCallback(
    async (kind: "accessibility" | "screen") => {
      const systemApi = window.electronAPI?.system;
      if (
        !systemApi?.requestPermission
        || !systemApi.openPermissionSettings
        || !systemApi.getPermissionStatus
      ) {
        setPermissionsError("Desktop permissions are unavailable in this window.");
        return;
      }

      setPermissionsError(null);
      setActivePermissionAction(kind);
      try {
        const result = await systemApi.requestPermission(kind);
        const nextStatus = await fetchPermissionStatus();
        if (!nextStatus[kind] && !result.granted && !result.openedSettings) {
          await systemApi.openPermissionSettings(kind);
        }
      } catch (error) {
        setPermissionsError(
          getSettingsErrorMessage(error, `Failed to update ${kind} permission.`),
        );
      } finally {
        setActivePermissionAction(null);
      }
    },
    [fetchPermissionStatus],
  );

  const handlePermissionRestart = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.quitForRestart) {
      setPermissionsError("Restart is unavailable in this window.");
      return;
    }

    setPermissionsError(null);
    setIsRestartingAfterPermissions(true);
    try {
      const result = await systemApi.quitForRestart();
      if (!result?.ok) {
        setIsRestartingAfterPermissions(false);
      }
    } catch (error) {
      setIsRestartingAfterPermissions(false);
      setPermissionsError(
        getSettingsErrorMessage(error, "Failed to restart Stella."),
      );
    }
  }, []);

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">Shortcuts</h3>
        <p className="settings-card-desc">
          {platform === "darwin"
            ? "Hold ⌘ (Command) and right-click anywhere on screen to open the Stella quick menu."
            : "Hold Ctrl and right-click anywhere on screen to open the Stella quick menu."}
        </p>
      </div>
      {platform === "darwin" ? (
        <div className="settings-card">
          <h3 className="settings-card-title">Permissions</h3>
          <p className="settings-card-desc">
            Stella can prompt for permissions when you use a feature, and you
            can also fix them here anytime.
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
                Required for the global ⌘+right-click shortcut and selected text.
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded
                  || permissionStatus.accessibility
                  || activePermissionAction === "accessibility"
                }
                onClick={() => void handlePermissionEnable("accessibility")}
              >
                {permissionStatus.accessibility
                  ? "Granted"
                  : activePermissionAction === "accessibility"
                    ? "Opening..."
                    : "Enable"}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">Screen Capture</div>
              <div className="settings-row-sublabel">
                Required for screenshot capture and vision features.
              </div>
              <div className="settings-row-sublabel">
                macOS may require Stella to close and reopen after you allow it.
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                disabled={
                  !permissionsLoaded
                  || permissionStatus.screen
                  || activePermissionAction === "screen"
                }
                onClick={() => void handlePermissionEnable("screen")}
              >
                {permissionStatus.screen
                  ? "Granted"
                  : activePermissionAction === "screen"
                    ? "Opening..."
                    : "Enable"}
              </Button>
            </div>
          </div>
          {screenRestartRecommended ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-label">Restart Stella</div>
                <div className="settings-row-sublabel">
                  Screen Capture was enabled while Stella was running. Reopen it
                  from the launcher to apply the change.
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
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Backups</div>
            <div className="settings-row-sublabel">
              Backups are encrypted on this device before upload.
            </div>
            <div className="settings-row-sublabel">
              Restore replaces local Stella files from the selected backup and restarts the app.
            </div>
            {backupError ? (
              <div
                className="settings-row-sublabel settings-card-desc--error"
                role="alert"
              >
                {backupError}
              </div>
            ) : null}
            <div className="settings-row-sublabel">
              Local backups: {formatBackupTimestamp(backupStatus?.lastSuccessAt)}
            </div>
            <div className="settings-row-sublabel">
              Remote backups: {formatBackupTimestamp(backupStatus?.lastRemoteSuccessAt)}
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
              onChange={(event) => void handleSyncModeChange(event.target.value)}
              disabled={!backupLoaded || isSavingSyncMode}
            >
              <option value="off">Off</option>
              <option value="on">Automatic hourly backups</option>
            </NativeSelect>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Back Up Now</div>
            <div className="settings-row-sublabel">
              Creates a fresh local snapshot and uploads it when your account is connected.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => void handleBackupNow()}
              disabled={!backupLoaded || isRunningBackup || Boolean(restoringSnapshotId)}
            >
              {isRunningBackup ? "Backing Up..." : "Back Up Now"}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Remote Backups</div>
            <div className="settings-row-sublabel">
              {hasConnectedAccount
                ? "Choose a backup to restore on this device."
                : "Sign in to upload and restore remote backups."}
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
                    {backup.objectCount} objects, {backup.entryCount} files
                  </div>
                  <div className="settings-row-sublabel">
                    Source device: {backup.sourceHostname || backup.sourceDeviceId}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Button
                    type="button"
                    variant="ghost"
                    className="settings-btn"
                    onClick={() => void handleRestoreBackup(backup.snapshotId)}
                    disabled={
                      isRunningBackup || restoringSnapshotId === backup.snapshotId
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
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Sign Out</div>
            <div className="settings-row-sublabel">
              Sign out of your account
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
            <div className="settings-row-label">Delete Data</div>
            <div className="settings-row-sublabel">
              Erase all conversations and memories.
            </div>
            <div className="settings-row-sublabel">
              This action is not available in the desktop app yet.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              disabled
            >
              Delete
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Delete Account</div>
            <div className="settings-row-sublabel">
              Permanently remove your account and all data.
            </div>
            <div className="settings-row-sublabel">
              This action is not available in the desktop app yet.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn settings-btn--danger"
              disabled
            >
              Delete
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models Tab
// ---------------------------------------------------------------------------

function ModelConfigSection() {
  const { hasConnectedAccount } = useAuthSessionState();
  const shouldQueryPreferences = hasConnectedAccount ? {} : "skip";
  const overridesJson = useQuery(
    api.data.preferences.getModelOverrides,
    shouldQueryPreferences,
  ) as string | undefined;
  const modelDefaults = useQuery(
    api.data.preferences.getModelDefaults,
    shouldQueryPreferences,
  ) as ModelDefaultEntry[] | undefined;
  const setOverride = useMutation(api.data.preferences.setModelOverride);
  const clearOverride = useMutation(api.data.preferences.clearModelOverride);
  const generalAgentEngine = useQuery(
    api.data.preferences.getGeneralAgentEngine,
    shouldQueryPreferences,
  ) as "default" | "claude_code_local" | undefined;
  const setGeneralAgentEngine = useMutation(
    api.data.preferences.setGeneralAgentEngine,
  );
  const selfModAgentEngine = useQuery(
    api.data.preferences.getSelfModAgentEngine,
    shouldQueryPreferences,
  ) as "default" | "claude_code_local" | undefined;
  const maxAgentConcurrency = useQuery(
    api.data.preferences.getMaxAgentConcurrency,
    shouldQueryPreferences,
  ) as number | undefined;
  const setMaxAgentConcurrency = useMutation(
    api.data.preferences.setMaxAgentConcurrency,
  );
  const { models: stellaModels } = useModelCatalog();
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
    if (!overridesJson) {
      return {};
    }

    try {
      return normalizeModelOverrides(
        JSON.parse(overridesJson) as Record<string, string>,
        defaultModelMap,
      );
    } catch {
      return {};
    }
  }, [defaultModelMap, overridesJson]);
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

  const runtimePreferencesLoaded =
    hasConnectedAccount &&
    generalAgentEngine !== undefined &&
    selfModAgentEngine !== undefined &&
    maxAgentConcurrency !== undefined;
  const modelPreferencesLoaded =
    hasConnectedAccount &&
    modelDefaults !== undefined &&
    overridesJson !== undefined;

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
    localGeneralAgentEngine !== generalAgentEngine
      ? localGeneralAgentEngine
      : null) ??
    generalAgentEngine ??
    "default";
  const effectiveMaxAgentConcurrency =
    (localMaxAgentConcurrency !== null &&
    localMaxAgentConcurrency !== maxAgentConcurrency
      ? localMaxAgentConcurrency
      : null) ??
    maxAgentConcurrency ??
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

      if (value === "") {
        setLocalOverrides((prev) => ({ ...prev, [agentType]: null }));
        try {
          await clearOverride({ agentType });
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
      } else {
        setLocalOverrides((prev) => ({ ...prev, [agentType]: value }));
        try {
          await setOverride({ agentType, model: value });
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
      }
    },
    [clearOverride, isSavingModelPreferences, localOverrides, setOverride],
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
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        await clearOverride({ agentType: key });
        return key;
      }),
    );

    const failedKeys = results.flatMap((result, index) =>
      result.status === "rejected" ? [keys[index]] : [],
    );

    if (failedKeys.length > 0) {
      setLocalOverrides((prev) => {
        const next = { ...prev };
        for (const key of failedKeys) {
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
        failedKeys.length === 1
          ? "Failed to reset one model setting."
          : `Failed to reset ${failedKeys.length} model settings.`,
      );
    }

    setIsSavingModelPreferences(false);
  }, [
    clearOverride,
    hasAnyOverride,
    isSavingModelPreferences,
    localOverrides,
    overrides,
  ]);

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
        await setGeneralAgentEngine({ engine });
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
    [
      isSavingRuntimePreference,
      localGeneralAgentEngine,
      setGeneralAgentEngine,
    ],
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
        await setMaxAgentConcurrency({ value: normalized });
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
    [
      isSavingRuntimePreference,
      localMaxAgentConcurrency,
      setMaxAgentConcurrency,
    ],
  );

  return (
    <>
      <div className="settings-card">
        <h3 className="settings-card-title">Agent Runtime</h3>
        <p className="settings-card-desc">
          Choose how the Orchestrator, General, and Self Mod agents run on this device.
        </p>
        {!hasConnectedAccount ? (
          <p className="settings-card-desc">
            Sign in to manage runtime settings.
          </p>
        ) : null}
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
              Orchestrator and General agents. Local CLI mode requires the corresponding{" "}
              <code>claude</code> CLI.
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
                <option value="loading">
                  {hasConnectedAccount
                    ? "Loading saved setting..."
                    : "Sign in required"}
                </option>
              </NativeSelect>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Max Agent Concurrency</div>
            <div className="settings-row-sublabel">
              Maximum number of local agent tasks running at once across
              General, Self Mod, and Claude Code.
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
                <option value="loading">
                  {hasConnectedAccount
                    ? "Loading saved setting..."
                    : "Sign in required"}
                </option>
              </NativeSelect>
            )}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">Model Configuration</h3>
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
          Override the default model for each agent type.
        </p>
        {!hasConnectedAccount ? (
          <p className="settings-card-desc">
            Sign in to manage model settings.
          </p>
        ) : null}
        {modelConfigError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {modelConfigError}
          </p>
        ) : null}
        {hasConnectedAccount && !modelPreferencesLoaded ? (
          <p className="settings-card-desc">Loading saved model settings...</p>
        ) : null}
        {modelPreferencesLoaded &&
          configurableAgents.map((agent) => {
            const current = overrides[agent.key] ?? "";
            const isDirectOverride = Boolean(current) && !isStellaSelection(current);
            const isCustomEditing = Object.prototype.hasOwnProperty.call(
              customModelDrafts,
              agent.key,
            );
            const selectValue =
              isDirectOverride || isCustomEditing ? "__custom__" : current;
            const customDraft = customModelDrafts[agent.key] ??
              (isDirectOverride ? current : "");
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
                    <option value="">
                      {defaultLabel}
                    </option>
                    {selectedStellaModel ? (
                      <option value={selectedStellaModel}>
                        {modelNamesById.get(selectedStellaModel) ?? selectedStellaModel}
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
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
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

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        await loadCredentials();
        if (!cancelled) {
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
  }, [loadCredentials]);

  const getCredentialForProvider = (providerKey: string) =>
    llmCredentials.find(
      (credential) =>
        credential.provider === providerKey && credential.status === "active",
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

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Provider Credentials</h3>
      <p className="settings-card-desc">
        Credentials stay on this device. If Stella has matching local provider
        credentials it calls that provider directly. Otherwise it uses your
        Stella provider access.
      </p>
      {credentialsError ? (
        <p className="settings-card-desc">{credentialsError}</p>
      ) : null}
      {LLM_PROVIDERS.map((provider) => {
        const credential = getCredentialForProvider(provider.key);
        const isEditing = editingProvider === provider.key;
        const isRemoving = removingProvider === provider.key;
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
                    {credential ? "Update Credential" : "Add Credential"}
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
// Settings Panel (scroll container with bottom fade)
// ---------------------------------------------------------------------------

function SettingsPanel({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const check = () => {
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      setAtBottom(isAtBottom);
    };

    check();
    el.addEventListener("scroll", check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="settings-panel-wrap" data-at-bottom={atBottom || undefined}>
      <div className="settings-panel" ref={ref}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsDialog
// ---------------------------------------------------------------------------

export const SettingsDialog = ({
  open,
  onOpenChange,
  onSignOut,
}: SettingsDialogProps) => {
  const [selectedTab, setSelectedTab] = useState<SettingsTab>(() =>
    hasBillingCheckoutCompletionMarker() ? "billing" : "basic",
  );
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(
    null,
  );
  const activeTab = hasBillingCheckoutCompletionMarker()
    ? "billing"
    : selectedTab;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="lg" className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogCloseButton />
          </DialogHeader>
          <DialogBody>
            <div className="settings-layout">
              <nav className="settings-sidebar">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`settings-sidebar-tab${activeTab === tab.key ? " settings-sidebar-tab--active" : ""}`}
                    onClick={() => setSelectedTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
              <SettingsPanel>
                {activeTab === "basic" ? (
                  <BasicTab
                    onSignOut={onSignOut}
                    onOpenLegal={setActiveLegalDoc}
                  />
                ) : activeTab === "models" ? (
                  <ModelsTab />
                ) : activeTab === "audio" ? (
                  <AudioTab />
                ) : activeTab === "connections" ? (
                  <ConnectionsTab />
                ) : (
                  <BillingTab />
                )}
              </SettingsPanel>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
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

export default SettingsDialog;
