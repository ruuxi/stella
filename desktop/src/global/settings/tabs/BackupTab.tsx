import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { showToast } from "@/ui/toast";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import type {
  BackupStatusSnapshot,
  BackupSummary,
} from "@/shared/types/electron";
import { getSettingsErrorMessage } from "./shared";

function formatBackupTimestamp(timestamp?: number) {
  if (!timestamp) {
    return "Never";
  }
  return new Date(timestamp).toLocaleString();
}

export function BackupTab() {
  const { hasConnectedAccount } = useAuthSessionState();
  const [billingNowMs] = useState(() => Date.now());
  const billingStatus = useConvexOneShot(api.billing.getSubscriptionStatus, {
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
            <Select
              className="settings-runtime-select"
              value={syncMode}
              onValueChange={(value) => void handleSyncModeChange(value)}
              disabled={
                !backupLoaded || isSavingSyncMode || isBillingStatusLoading
              }
              aria-label="Backups"
              options={[
                { value: "off", label: "Off" },
                { value: "on", label: "Automatic hourly backups" },
              ]}
            />
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
