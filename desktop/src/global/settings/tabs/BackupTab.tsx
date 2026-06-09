import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { showToast } from "@/ui/toast";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useT } from "@/shared/i18n";
import type {
  BackupStatusSnapshot,
  BackupSummary,
} from "@/shared/types/electron";
import { getSettingsErrorMessage } from "./shared";

function formatBackupTimestamp(timestamp: number | undefined, neverLabel: string) {
  if (!timestamp) {
    return neverLabel;
  }
  return new Date(timestamp).toLocaleString();
}

export function BackupTab() {
  const t = useT();
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
            getSettingsErrorMessage(error, t("settings.backup.errors.load")),
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
  }, [loadBackupState, t]);

  const handleSyncModeChange = useCallback(
    async (value: string) => {
      const nextMode = value === "on" ? "on" : "off";
      if (isSavingSyncMode) {
        return;
      }
      const previousMode = syncMode;
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setLocalSyncMode) {
        setBackupError(t("settings.backup.errors.unavailable"));
        return;
      }
      if (nextMode === "on" && !hasConnectedAccount) {
        setBackupError(t("settings.backup.errors.signInRequired"));
        return;
      }
      if (nextMode === "on" && isBillingStatusLoading) {
        setBackupError(t("settings.backup.errors.checkingPlan"));
        return;
      }
      if (nextMode === "on" && isBackupUpgradeRequired) {
        setBackupError(t("settings.backup.errors.subscriptionRequired"));
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
          getSettingsErrorMessage(error, t("settings.backup.errors.updateMode")),
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
      t,
    ],
  );

  const handleBackupNow = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.backUpNow) {
      setBackupError(t("settings.backup.errors.backupUnavailable"));
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
            ? t("settings.backup.toasts.completedTitle")
            : result.status === "queued"
              ? t("settings.backup.toasts.queuedTitle")
              : result.status === "deferred"
                ? t("settings.backup.toasts.deferredTitle")
                : t("settings.backup.toasts.noneNeededTitle"),
        description: result.message,
      });
    } catch (error) {
      const message = getSettingsErrorMessage(
        error,
        t("settings.backup.errors.startBackup"),
      );
      setBackupError(message);
      showToast({
        title: t("settings.backup.toasts.failedTitle"),
        description: message,
        variant: "error",
      });
    } finally {
      setIsRunningBackup(false);
    }
  }, [loadBackupState, t]);

  const handleRestoreBackup = useCallback(
    async (snapshotId: string) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.restoreBackup) {
        setBackupError(t("settings.backup.errors.restoreUnavailable"));
        return;
      }
      setBackupError(null);
      setRestoringSnapshotId(snapshotId);
      try {
        await systemApi.restoreBackup(snapshotId);
        showToast({
          title: t("settings.backup.toasts.restorePreparedTitle"),
          description: t("settings.backup.toasts.restorePreparedDescription"),
        });
      } catch (error) {
        const message = getSettingsErrorMessage(
          error,
          t("settings.backup.errors.restore"),
        );
        setBackupError(message);
        showToast({
          title: t("settings.backup.toasts.restoreFailedTitle"),
          description: message,
          variant: "error",
        });
      } finally {
        setRestoringSnapshotId(null);
      }
    },
    [t],
  );

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">{t("settings.backup.title")}</h3>
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
            {t("settings.backup.upgradeNotice")}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.backup.automatic.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.backup.automatic.lastLocal", {
                time: formatBackupTimestamp(
                  backupStatus?.lastSuccessAt,
                  t("settings.backup.never"),
                ),
              })}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.backup.automatic.lastRemote", {
                time: formatBackupTimestamp(
                  backupStatus?.lastRemoteSuccessAt,
                  t("settings.backup.never"),
                ),
              })}
            </div>
            {backupStatus?.lastRemoteError ? (
              <div className="settings-row-sublabel">
                {t("settings.backup.automatic.remoteIssue", {
                  error: backupStatus.lastRemoteError,
                })}
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
              aria-label={t("settings.backup.automatic.ariaLabel")}
              options={[
                { value: "off", label: t("settings.backup.automatic.off") },
                { value: "on", label: t("settings.backup.automatic.hourly") },
              ]}
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.backup.backupNow.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.backup.backupNow.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => void handleBackupNow()}
              disabled={
                !backupLoaded || isRunningBackup || Boolean(restoringSnapshotId)
              }
            >
              {isRunningBackup
                ? t("settings.backup.backupNow.working")
                : t("settings.backup.backupNow.action")}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.backup.saved.label")}
            </div>
            <div className="settings-row-sublabel">
              {hasConnectedAccount
                ? t("settings.backup.saved.signedInDescription")
                : t("settings.backup.saved.signedOutDescription")}
            </div>
          </div>
        </div>
        {hasConnectedAccount && remoteBackups.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-sublabel">
                {t("settings.backup.saved.empty")}
              </div>
            </div>
          </div>
        ) : null}
        {hasConnectedAccount
          ? remoteBackups.map((backup) => (
              <div key={backup.snapshotId} className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-label">
                    {formatBackupTimestamp(
                      backup.createdAt,
                      t("settings.backup.never"),
                    )}
                    {backup.isLatest
                      ? ` (${t("settings.backup.saved.latest")})`
                      : ""}
                  </div>
                  <div className="settings-row-sublabel">
                    {t("settings.backup.saved.files", {
                      count: backup.entryCount,
                    })}
                  </div>
                  <div className="settings-row-sublabel">
                    {t("settings.backup.saved.from", {
                      source: backup.sourceHostname || backup.sourceDeviceId,
                    })}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Button
                    type="button"
                    variant="ghost"
                    className="pill-btn"
                    onClick={() => void handleRestoreBackup(backup.snapshotId)}
                    disabled={
                      isRunningBackup ||
                      restoringSnapshotId === backup.snapshotId
                    }
                  >
                    {restoringSnapshotId === backup.snapshotId
                      ? t("settings.backup.saved.restoring")
                      : t("settings.backup.saved.restore")}
                  </Button>
                </div>
              </div>
            ))
          : null}
      </div>
    </div>
  );
}
