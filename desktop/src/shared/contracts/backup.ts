export type BackupSummary = {
  snapshotId: string;
  snapshotHash: string;
  sourceDeviceId: string;
  sourceHostname?: string;
  createdAt: number;
  entryCount: number;
  objectCount: number;
  isLatest: boolean;
};

export type BackupStatusSnapshot = {
  version: number;
  enabled: boolean;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastSnapshotHash?: string;
  lastManifestId?: string;
  lastError?: string;
  pendingReason?: string;
  lastRemoteSuccessAt?: number;
  lastRemoteManifestId?: string;
  lastRemoteError?: string;
  restoreInProgress?: boolean;
  lastRestoreAt?: number;
  lastRestoreError?: string;
};

export type BackupNowResult = {
  status: "completed" | "unchanged" | "queued" | "deferred";
  message: string;
  manifestId?: string;
  remoteUploaded?: boolean;
};

export type RestoreBackupResult = {
  status: "staged";
  snapshotId: string;
};
