import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { RuntimeHealthSnapshot } from "../../../runtime/protocol/index.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import {
  ensurePrivateDir,
  writePrivateFile,
} from "../../../runtime/kernel/shared/private-fs.js";
import {
  deleteProtectedValue,
  protectValue,
  unprotectValue,
} from "../../../runtime/kernel/shared/protected-storage.js";
import type {
  BackupNowResult,
  BackupStatusSnapshot,
  BackupSummary,
  RestoreBackupResult,
} from "../../src/shared/contracts/backup.js";

const execFileAsync = promisify(execFile);

const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const BUSY_RETRY_DELAY_MS = 60 * 1000;
const IDLE_QUIET_PERIOD_MS = 15 * 1000;
const INITIAL_RUN_DELAY_MS = 15 * 1000;
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const BACKUP_VERSION = 1;
const ENCRYPTION_SCOPE = "continuous-backup-key";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const REMOTE_FETCH_TIMEOUT_MS = 60_000;
const REMOTE_BACKUP_KEY_PATH = "/api/backups/key";
const REMOTE_BACKUP_LIST_PATH = "/api/backups/list";
const REMOTE_BACKUP_PREPARE_UPLOAD_PATH = "/api/backups/prepare-upload";
const REMOTE_BACKUP_FINALIZE_UPLOAD_PATH = "/api/backups/finalize-upload";
const REMOTE_BACKUP_RESTORE_MANIFEST_PATH = "/api/backups/restore-manifest";
const REMOTE_BACKUP_OBJECT_DOWNLOADS_PATH = "/api/backups/object-downloads";
const REMOTE_BACKUP_MAX_OBJECT_BATCH = 1_000;

const PRESERVED_STATE_FILES = new Set([
  "device.json",
  "llm_credentials.json",
  "security_policy.json",
]);
const STATE_DIRECTORY_SKIP_PREFIXES = new Set([
  "backups",
  "cache",
  "logs",
  "electron-user-data",
  "tmp",
]);

type BackupServiceDeps = {
  stellaRoot: string;
  getStellaRoot: () => string | null;
  getRunner: () => StellaHostRunner | null;
  getAuthToken: () => Promise<string | null>;
  getConvexSiteUrl: () => string | null;
  getDeviceId: () => string | null;
  processRuntime: {
    setManagedTimeout: (callback: () => void, delayMs: number) => () => void;
    setManagedInterval: (callback: () => void, delayMs: number) => () => void;
  };
};

type BackupObjectMetadata = {
  version: number;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  plaintextSha256: string;
  plaintextSize: number;
  ivBase64Url: string;
  authTagBase64Url: string;
};

type BackupManifestEntry = {
  scope:
    | "repo-worktree"
    | "repo-git-bundle"
    | "sqlite"
    | "state"
    | "workspace";
  path: string;
  sha256: string;
  objectId: string;
  size: number;
  mode?: number;
  mtimeMs?: number;
};

type BackupManifest = {
  version: number;
  snapshotId: string;
  createdAt: number;
  snapshotHash: string;
  repoRoot: string;
  stellaHomePath: string;
  entries: BackupManifestEntry[];
};

type BackupStatus = BackupStatusSnapshot;

type BackupConfig = {
  version: number;
  wrappedKey: string;
  updatedAt: number;
  hostname: string;
  keyFingerprint?: string;
};

type BackupKeyMaterial = {
  key: Buffer;
  fingerprint: string;
  hostname: string;
};

type BackupRunResult =
  | {
      status: "unchanged";
      snapshotHash: string;
    }
  | {
      status: "completed";
      snapshotHash: string;
      manifest: BackupManifest;
      keyMaterial: BackupKeyMaterial;
      remoteUploaded: boolean;
    };

type RemoteServiceRequest = {
  endpoint: string;
  headers: Record<string, string>;
  deviceId: string;
};

type RemotePrepareUploadResponse = {
  existingObjectIds: string[];
  missingObjects: Array<{
    objectId: string;
    r2Key: string;
    uploadUrl: string;
  }>;
  manifest: {
    r2Key: string;
    uploadUrl: string;
  };
};

type RemoteKeyEnsureResponse = {
  status: "created" | "matched" | "mismatch";
  keyFingerprint: string;
  updatedAt: number;
  remoteKeyBase64Url?: string;
};

type RemoteManifestPlan = {
  snapshot: BackupSummary;
  keyBase64Url: string;
  manifest: {
    downloadUrl: string;
    r2Key: string;
    plaintextSha256: string;
    plaintextSize: number;
    algorithm: string;
    ivBase64Url: string;
    authTagBase64Url: string;
  };
};

type RemoteObjectDownloadPlan = {
  objects: Array<{
    objectId: string;
    downloadUrl: string;
    r2Key: string;
    plaintextSha256: string;
    plaintextSize: number;
    algorithm: string;
    ivBase64Url: string;
    authTagBase64Url: string;
  }>;
};

type RestoreRuntimeOps = {
  shutdownRuntime: () => Promise<void>;
  restartRuntime: () => Promise<void>;
};

const normalizePath = (value: string) => value.replace(/\\/g, "/");

const createSha256 = (buffer: Buffer | string) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

const sanitizeError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String(error ?? "Unknown backup error.");

const quoteSqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

const fileExists = async (targetPath: string) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const runGit = async (repoRoot: string, args: string[]): Promise<Buffer> => {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "buffer",
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
};

const walkFiles = async (
  rootPath: string,
  shouldSkip: (relativePath: string, isDirectory: boolean) => boolean,
  relativePrefix = "",
): Promise<string[]> => {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = normalizePath(
      path.posix.join(relativePrefix, entry.name),
    );
    if (shouldSkip(relativePath, entry.isDirectory())) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(rootPath, shouldSkip, relativePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
};

const listGitWorkingTreeFiles = async (
  repoRoot: string,
  excludePrefixes: string[],
): Promise<string[]> => {
  const output = await runGit(repoRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const files = output
    .toString("utf8")
    .split("\0")
    .map((value) => normalizePath(value.trim()))
    .filter(Boolean);
  const unique = new Set<string>();
  for (const filePath of files) {
    if (filePath === ".git" || filePath.startsWith(".git/")) {
      continue;
    }
    if (
      excludePrefixes.some(
        (prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`),
      )
    ) {
      continue;
    }
    unique.add(filePath);
  }
  return [...unique].sort();
};

const createEncryptedObject = (key: Buffer, plaintext: Buffer) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    metadata: {
      version: BACKUP_VERSION,
      algorithm: ENCRYPTION_ALGORITHM,
      plaintextSha256: createSha256(plaintext),
      plaintextSize: plaintext.byteLength,
      ivBase64Url: iv.toString("base64url"),
      authTagBase64Url: authTag.toString("base64url"),
    } satisfies BackupObjectMetadata,
    ciphertext,
  };
};

const decryptEncryptedObject = (
  key: Buffer,
  metadata: BackupObjectMetadata,
  ciphertext: Buffer,
) => {
  if (metadata.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(`Unsupported backup encryption algorithm: ${metadata.algorithm}`);
  }
  const decipher = crypto.createDecipheriv(
    metadata.algorithm,
    key,
    Buffer.from(metadata.ivBase64Url, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(metadata.authTagBase64Url, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  const plaintextSha256 = createSha256(plaintext);
  if (plaintextSha256 !== metadata.plaintextSha256) {
    throw new Error("Backup object integrity check failed.");
  }
  return plaintext;
};

const splitIntoChunks = <T>(items: T[], chunkSize: number): T[][] => {
  if (chunkSize < 1) {
    return [items];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const resolveInsideRoot = (rootPath: string, relativePath: string) => {
  const resolved = path.resolve(rootPath, relativePath);
  const normalizedRoot = `${path.resolve(rootPath)}${path.sep}`;
  if (resolved !== path.resolve(rootPath) && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to restore path outside root: ${relativePath}`);
  }
  return resolved;
};

const removeFileIfExists = async (targetPath: string) => {
  await fs.rm(targetPath, { force: true }).catch(() => undefined);
};

const isPreservedStatePath = (relativePath: string) =>
  PRESERVED_STATE_FILES.has(normalizePath(relativePath));

const shouldSkipStatePath = (relativePath: string, isDirectory: boolean) => {
  if (!relativePath) return false;
  const topLevel = normalizePath(relativePath).split("/")[0];
  if (STATE_DIRECTORY_SKIP_PREFIXES.has(topLevel)) {
    return true;
  }
  if (
    relativePath === "stella.sqlite"
    || relativePath === "stella.sqlite-shm"
    || relativePath === "stella.sqlite-wal"
  ) {
    return true;
  }
  if (isPreservedStatePath(relativePath)) {
    return true;
  }
  return topLevel === "tmp" && isDirectory;
};

export class BackupService {
  private started = false;
  private enabled = false;
  private runInFlight = false;
  private runRequested = false;
  private lastBusyAt: number | null = null;
  private cancelInterval: (() => void) | null = null;
  private cancelPendingRun: (() => void) | null = null;
  private cancelBusyRetry: (() => void) | null = null;

  constructor(private readonly deps: BackupServiceDeps) {}

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.refreshEnabledState().catch((error) => {
      console.warn("[backup] Failed to initialize backup mode:", error);
    });
  }

  stop() {
    this.started = false;
    this.enabled = false;
    this.cancelInterval?.();
    this.cancelInterval = null;
    this.cancelPendingRun?.();
    this.cancelPendingRun = null;
    this.cancelBusyRetry?.();
    this.cancelBusyRetry = null;
  }

  async refreshEnabledState() {
    const stellaHomePath = this.deps.getStellaRoot();
    const nextEnabled = stellaHomePath
      ? (await this.readSyncMode(stellaHomePath)) === "on"
      : false;
    this.setEnabled(nextEnabled);
  }

  async setMode(mode: "on" | "off") {
    this.setEnabled(mode === "on");
    const stellaHomePath = this.deps.getStellaRoot();
    if (!stellaHomePath) {
      return;
    }
    await this.writeStatus(stellaHomePath, (current) => ({
      ...current,
      enabled: mode === "on",
      ...(mode === "off" ? { pendingReason: undefined } : {}),
    }));
  }

  async getStatus(): Promise<BackupStatus> {
    const stellaHomePath = this.deps.getStellaRoot();
    if (!stellaHomePath) {
      return {
        version: BACKUP_VERSION,
        enabled: false,
      };
    }
    return await this.readStatus(stellaHomePath);
  }

  async backupNow(): Promise<BackupNowResult> {
    const stellaHomePath = this.deps.getStellaRoot();
    if (!stellaHomePath) {
      throw new Error("Local Stella home is unavailable.");
    }
    if (this.runInFlight) {
      this.runRequested = true;
      return {
        status: "queued",
        message: "A backup is already running. Stella will run another backup afterward.",
      };
    }

    const busy = await this.isRuntimeBusy();
    if (busy) {
      this.lastBusyAt = Date.now();
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: this.enabled,
        pendingReason: "Waiting for agents to go idle before backing up.",
      }));
      return {
        status: "deferred",
        message: "Waiting for Stella to go idle before starting a backup.",
      };
    }

    if (
      this.lastBusyAt
      && Date.now() - this.lastBusyAt < IDLE_QUIET_PERIOD_MS
    ) {
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: this.enabled,
        pendingReason: "Waiting for a short quiet period before backing up.",
      }));
      return {
        status: "deferred",
        message: "Waiting for a short quiet period before starting a backup.",
      };
    }

    this.runInFlight = true;
    this.runRequested = false;
    try {
      const result = await this.performBackup(stellaHomePath, "manual");
      if (result.status === "unchanged") {
        return {
          status: "unchanged",
          message: "No backup was needed because nothing changed since the last snapshot.",
        };
      }
      return {
        status: "completed",
        message: result.remoteUploaded
          ? "Backup completed and uploaded."
          : "Backup completed locally.",
        manifestId: result.manifest.snapshotId,
        remoteUploaded: result.remoteUploaded,
      };
    } catch (error) {
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: this.enabled,
        lastAttemptAt: Date.now(),
        lastError: sanitizeError(error),
        pendingReason: undefined,
      }));
      throw error;
    } finally {
      this.runInFlight = false;
    }
  }

  async listBackups(limit = 25): Promise<BackupSummary[]> {
    const request = await this.createRemoteServiceRequest(REMOTE_BACKUP_LIST_PATH);
    const url = new URL(request.endpoint);
    url.searchParams.set("limit", String(limit));
    const response = await this.fetchRemoteJson<{ backups: BackupSummary[] }>(
      url.toString(),
      {
        method: "GET",
        headers: request.headers,
      },
    );
    return response.backups;
  }

  async restoreBackup(
    snapshotId: string,
    runtimeOps: RestoreRuntimeOps,
  ): Promise<RestoreBackupResult> {
    const stellaHomePath = this.deps.getStellaRoot();
    if (!stellaHomePath) {
      throw new Error("Local Stella home is unavailable.");
    }
    if (this.runInFlight) {
      throw new Error("A backup is already running. Try restoring again in a moment.");
    }
    if (await this.isRuntimeBusy()) {
      throw new Error("Stella is busy right now. Wait for active tasks to finish before restoring.");
    }
    await this.ensureRepoRestoreSafe(stellaHomePath);

    const restoreTempRoot = path.join(
      this.getBackupsRoot(stellaHomePath),
      "tmp",
      `restore-${snapshotId}-${Date.now()}`,
    );
    await ensurePrivateDir(restoreTempRoot);
    await this.writeStatus(stellaHomePath, (current) => ({
      ...current,
      restoreInProgress: true,
      lastRestoreError: undefined,
      pendingReason: "Preparing restore data.",
    }));

    let runtimeStopped = false;
    try {
      const manifestRequest = await this.createRemoteServiceRequest(
        REMOTE_BACKUP_RESTORE_MANIFEST_PATH,
      );
      const manifestPlan = await this.fetchRemoteJson<RemoteManifestPlan>(
        manifestRequest.endpoint,
        {
          method: "POST",
          headers: manifestRequest.headers,
          body: JSON.stringify({ snapshotId }),
        },
      );
      const remoteKey = Buffer.from(manifestPlan.keyBase64Url, "base64url");
      if (remoteKey.byteLength !== KEY_BYTES) {
        throw new Error("Remote backup key is invalid.");
      }
      const manifestCiphertext = await this.downloadBinary(
        manifestPlan.manifest.downloadUrl,
      );
      const manifestPlaintext = decryptEncryptedObject(
        remoteKey,
        {
          version: BACKUP_VERSION,
          algorithm: manifestPlan.manifest.algorithm as typeof ENCRYPTION_ALGORITHM,
          plaintextSha256: manifestPlan.manifest.plaintextSha256,
          plaintextSize: manifestPlan.manifest.plaintextSize,
          ivBase64Url: manifestPlan.manifest.ivBase64Url,
          authTagBase64Url: manifestPlan.manifest.authTagBase64Url,
        },
        manifestCiphertext,
      );
      const manifest = JSON.parse(
        manifestPlaintext.toString("utf8"),
      ) as BackupManifest;

      const uniqueObjectIds = [...new Set(manifest.entries.map((entry) => entry.objectId))];
      const objectPlanBatches = await Promise.all(
        splitIntoChunks(uniqueObjectIds, REMOTE_BACKUP_MAX_OBJECT_BATCH).map(
          async (objectIds) => {
            const request = await this.createRemoteServiceRequest(
              REMOTE_BACKUP_OBJECT_DOWNLOADS_PATH,
            );
            return await this.fetchRemoteJson<RemoteObjectDownloadPlan>(
              request.endpoint,
              {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify({ objectIds }),
              },
            );
          },
        ),
      );
      const objectPlans = new Map(
        objectPlanBatches
          .flatMap((batch) => batch.objects)
          .map((object) => [object.objectId, object] as const),
      );

      const stagedObjectsDir = path.join(restoreTempRoot, "objects");
      await ensurePrivateDir(stagedObjectsDir);
      for (const objectId of uniqueObjectIds) {
        const objectPlan = objectPlans.get(objectId);
        if (!objectPlan) {
          throw new Error(`Missing remote restore object: ${objectId}`);
        }
        const ciphertext = await this.downloadBinary(objectPlan.downloadUrl);
        const plaintext = decryptEncryptedObject(
          remoteKey,
          {
            version: BACKUP_VERSION,
            algorithm: objectPlan.algorithm as typeof ENCRYPTION_ALGORITHM,
            plaintextSha256: objectPlan.plaintextSha256,
            plaintextSize: objectPlan.plaintextSize,
            ivBase64Url: objectPlan.ivBase64Url,
            authTagBase64Url: objectPlan.authTagBase64Url,
          },
          ciphertext,
        );
        await fs.writeFile(path.join(stagedObjectsDir, objectId), plaintext, {
          mode: 0o600,
        });
      }

      this.cancelInterval?.();
      this.cancelPendingRun?.();
      this.cancelBusyRetry?.();
      await runtimeOps.shutdownRuntime();
      runtimeStopped = true;

      await this.applyRestoreFromManifest({
        stellaHomePath,
        manifest,
        stagedObjectsDir,
      });
      await this.persistEncryptionKey(
        stellaHomePath,
        remoteKey,
        manifest.snapshotId,
      );
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: this.enabled,
        restoreInProgress: false,
        lastRestoreAt: Date.now(),
        lastRestoreError: undefined,
        pendingReason: undefined,
        lastSnapshotHash: manifest.snapshotHash,
        lastManifestId: manifest.snapshotId,
      }));
      return {
        status: "staged",
        snapshotId: manifest.snapshotId,
      };
    } catch (error) {
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: this.enabled,
        restoreInProgress: false,
        lastRestoreError: sanitizeError(error),
        pendingReason: undefined,
      }));
      if (runtimeStopped) {
        await runtimeOps.restartRuntime().catch(() => undefined);
      }
      throw error;
    } finally {
      await fs.rm(restoreTempRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (this.started && this.enabled) {
        this.setEnabled(true);
      }
    }
  }

  private setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.cancelInterval?.();
    this.cancelInterval = null;
    this.cancelPendingRun?.();
    this.cancelPendingRun = null;
    this.cancelBusyRetry?.();
    this.cancelBusyRetry = null;

    if (!this.started || !enabled) {
      return;
    }

    this.cancelInterval = this.deps.processRuntime.setManagedInterval(() => {
      this.requestRun("scheduled");
    }, BACKUP_INTERVAL_MS);
    this.scheduleRun(INITIAL_RUN_DELAY_MS, "startup");
  }

  private scheduleRun(delayMs: number, reason: string) {
    if (!this.started || !this.enabled) {
      return;
    }
    this.runRequested = true;
    this.cancelPendingRun?.();
    this.cancelPendingRun = this.deps.processRuntime.setManagedTimeout(() => {
      this.cancelPendingRun = null;
      void this.maybeRun(reason);
    }, delayMs);
  }

  private requestRun(reason: string) {
    if (!this.started || !this.enabled) {
      return;
    }
    if (this.runInFlight) {
      this.runRequested = true;
      return;
    }
    this.scheduleRun(0, reason);
  }

  private async maybeRun(reason: string) {
    if (!this.started || !this.enabled || this.runInFlight) {
      return;
    }

    const stellaHomePath = this.deps.getStellaRoot();
    if (!stellaHomePath) {
      return;
    }

    const busy = await this.isRuntimeBusy();
    if (busy) {
      this.lastBusyAt = Date.now();
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: true,
        pendingReason: "Waiting for agents to go idle before backing up.",
      }));
      this.cancelBusyRetry?.();
      this.cancelBusyRetry = this.deps.processRuntime.setManagedTimeout(() => {
        this.cancelBusyRetry = null;
        void this.maybeRun("busy-retry");
      }, BUSY_RETRY_DELAY_MS);
      return;
    }

    if (
      this.lastBusyAt &&
      Date.now() - this.lastBusyAt < IDLE_QUIET_PERIOD_MS
    ) {
      this.cancelBusyRetry?.();
      this.cancelBusyRetry = this.deps.processRuntime.setManagedTimeout(() => {
        this.cancelBusyRetry = null;
        void this.maybeRun("idle-quiet-period");
      }, IDLE_QUIET_PERIOD_MS);
      return;
    }

    this.runInFlight = true;
    this.runRequested = false;
    try {
      await this.performBackup(stellaHomePath, reason);
    } catch (error) {
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: true,
        lastAttemptAt: Date.now(),
        lastError: sanitizeError(error),
        pendingReason: undefined,
      }));
      console.warn("[backup] Backup attempt failed:", error);
    } finally {
      this.runInFlight = false;
      if (this.runRequested && this.enabled) {
        this.scheduleRun(BUSY_RETRY_DELAY_MS, "queued");
      }
    }
  }

  private async isRuntimeBusy(): Promise<boolean> {
    const runner = this.deps.getRunner();
    if (!runner) {
      return false;
    }

    let health: RuntimeHealthSnapshot | null = null;
    try {
      health = await runner.client.health();
    } catch {
      return false;
    }

    return Boolean(health?.activeRunId) || (health?.activeAgentCount ?? 0) > 0;
  }

  private async performBackup(
    stellaHomePath: string,
    _reason: string,
  ): Promise<BackupRunResult> {
    const snapshotId = `backup-${Date.now()}`;
    const backupsRoot = this.getBackupsRoot(stellaHomePath);
    const manifestsDir = path.join(backupsRoot, "manifests");
    const tempRoot = path.join(backupsRoot, "tmp", snapshotId);
    await ensurePrivateDir(backupsRoot);
    await ensurePrivateDir(manifestsDir);
    await ensurePrivateDir(tempRoot);

    await this.writeStatus(stellaHomePath, (current) => ({
      ...current,
      enabled: true,
      lastAttemptAt: Date.now(),
      lastError: undefined,
    }));

    try {
      const keyMaterial = await this.loadOrCreateEncryptionKey(stellaHomePath);
      const entries = await this.collectEntries({
        stellaHomePath,
        tempRoot,
        encryptionKey: keyMaterial.key,
      });
      const snapshotHash = createSha256(
        JSON.stringify(
          entries.map((entry) => ({
            scope: entry.scope,
            path: entry.path,
            sha256: entry.sha256,
            size: entry.size,
            mode: entry.mode ?? null,
          })),
        ),
      );

      const status = await this.readStatus(stellaHomePath);
      if (status.lastSnapshotHash === snapshotHash) {
        await this.writeStatus(stellaHomePath, (current) => ({
          ...current,
          enabled: true,
          lastAttemptAt: Date.now(),
          pendingReason: undefined,
        }));
        return {
          status: "unchanged",
          snapshotHash,
        };
      }

      const manifest: BackupManifest = {
        version: BACKUP_VERSION,
        snapshotId,
        createdAt: Date.now(),
        snapshotHash,
        repoRoot: this.deps.stellaRoot,
        stellaHomePath,
        entries,
      };
      await writePrivateFile(
        path.join(manifestsDir, `${snapshotId}.json`),
        JSON.stringify(manifest, null, 2),
      );
      let remoteUploaded = false;
      try {
        remoteUploaded = await this.uploadManifestRemote(
          stellaHomePath,
          manifest,
          keyMaterial,
        );
      } catch (error) {
        await this.writeStatus(stellaHomePath, (current) => ({
          ...current,
          enabled: true,
          lastRemoteError: sanitizeError(error),
        }));
      }
      await this.writeStatus(stellaHomePath, (current) => ({
        ...current,
        enabled: true,
        lastSuccessAt: Date.now(),
        lastSnapshotHash: snapshotHash,
        lastManifestId: snapshotId,
        lastError: undefined,
        pendingReason: undefined,
      }));
      return {
        status: "completed",
        snapshotHash,
        manifest,
        keyMaterial,
        remoteUploaded,
      };
    } finally {
      await fs
        .rm(tempRoot, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  private async collectEntries(args: {
    stellaHomePath: string;
    tempRoot: string;
    encryptionKey: Buffer;
  }): Promise<BackupManifestEntry[]> {
    const repoEntries = await this.collectRepoEntries(args);
    const gitBundleEntry = await this.collectGitBundleEntry(args);
    const sqliteEntry = await this.collectSqliteEntry(args);
    const stateEntries = await this.collectDirectoryEntries({
      ...args,
      rootPath: path.join(args.stellaHomePath, "state"),
      scope: "state",
      shouldSkip: (relativePath, isDirectory) => {
        if (!relativePath) return false;
        const topLevel = relativePath.split("/")[0];
        if (
          topLevel === "backups" ||
          topLevel === "cache" ||
          topLevel === "logs" ||
          topLevel === "electron-user-data"
        ) {
          return true;
        }
        if (topLevel === "tmp" && isDirectory) {
          return true;
        }
        return (
          relativePath === "stella.sqlite" ||
          relativePath === "stella.sqlite-shm" ||
          relativePath === "stella.sqlite-wal"
        );
      },
    });
    const workspaceEntries = await this.collectDirectoryEntries({
      ...args,
      rootPath: path.join(args.stellaHomePath, "workspace"),
      scope: "workspace",
      shouldSkip: () => false,
    });

    return [
      ...repoEntries,
      ...(gitBundleEntry ? [gitBundleEntry] : []),
      ...(sqliteEntry ? [sqliteEntry] : []),
      ...stateEntries,
      ...workspaceEntries,
    ].sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) ||
        left.path.localeCompare(right.path),
    );
  }

  private async collectRepoEntries(args: {
    stellaHomePath: string;
    encryptionKey: Buffer;
  }): Promise<BackupManifestEntry[]> {
    const relativeHome = normalizePath(
      path.relative(this.deps.stellaRoot, args.stellaHomePath),
    );
    const excludePrefixes =
      relativeHome && !relativeHome.startsWith("..")
        ? [
            normalizePath(path.posix.join(relativeHome, "state")),
            normalizePath(path.posix.join(relativeHome, "workspace")),
          ]
        : [];
    const repoFiles = await listGitWorkingTreeFiles(
      this.deps.stellaRoot,
      excludePrefixes,
    );
    const entries: BackupManifestEntry[] = [];
    for (const relativePath of repoFiles) {
      const absolutePath = path.join(this.deps.stellaRoot, relativePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      entries.push(
        await this.captureFile({
          absolutePath,
          manifestPath: relativePath,
          scope: "repo-worktree",
          stellaHomePath: args.stellaHomePath,
          encryptionKey: args.encryptionKey,
        }),
      );
    }
    return entries;
  }

  private async collectGitBundleEntry(args: {
    stellaHomePath: string;
    tempRoot: string;
    encryptionKey: Buffer;
  }): Promise<BackupManifestEntry | null> {
    const bundlePath = path.join(args.tempRoot, "repo.bundle");
    await execFileAsync(
      "git",
      ["-C", this.deps.stellaRoot, "bundle", "create", bundlePath, "--all"],
      {
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    if (!(await fileExists(bundlePath))) {
      return null;
    }
    return await this.captureFile({
      absolutePath: bundlePath,
      manifestPath: "repo.bundle",
      scope: "repo-git-bundle",
      stellaHomePath: args.stellaHomePath,
      encryptionKey: args.encryptionKey,
    });
  }

  private async collectSqliteEntry(args: {
    stellaHomePath: string;
    tempRoot: string;
    encryptionKey: Buffer;
  }): Promise<BackupManifestEntry | null> {
    const sqlitePath = path.join(args.stellaHomePath, "state", "stella.sqlite");
    if (!(await fileExists(sqlitePath))) {
      return null;
    }
    const snapshotPath = path.join(args.tempRoot, "stella.snapshot.sqlite");
    await fs.rm(snapshotPath, { force: true }).catch(() => undefined);
    const db = new DatabaseSync(sqlitePath, { timeout: 5000 });
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      db.exec(`VACUUM INTO ${quoteSqlString(snapshotPath)}`);
    } finally {
      db.close();
    }
    return await this.captureFile({
      absolutePath: snapshotPath,
      manifestPath: "state/stella.sqlite",
      scope: "sqlite",
      stellaHomePath: args.stellaHomePath,
      encryptionKey: args.encryptionKey,
    });
  }

  private async collectDirectoryEntries(args: {
    stellaHomePath: string;
    rootPath: string;
    scope: "state" | "workspace";
    shouldSkip: (relativePath: string, isDirectory: boolean) => boolean;
    encryptionKey: Buffer;
  }): Promise<BackupManifestEntry[]> {
    if (!(await fileExists(args.rootPath))) {
      return [];
    }
    const files = await walkFiles(args.rootPath, args.shouldSkip);
    const entries: BackupManifestEntry[] = [];
    for (const relativePath of files) {
      const absolutePath = path.join(args.rootPath, relativePath);
      entries.push(
        await this.captureFile({
          absolutePath,
          manifestPath: `${args.scope}/${relativePath}`,
          scope: args.scope,
          stellaHomePath: args.stellaHomePath,
          encryptionKey: args.encryptionKey,
        }),
      );
    }
    return entries;
  }

  private async captureFile(args: {
    absolutePath: string;
    manifestPath: string;
    scope: BackupManifestEntry["scope"];
    stellaHomePath: string;
    encryptionKey: Buffer;
  }): Promise<BackupManifestEntry> {
    const stat = await fs.stat(args.absolutePath);
    const plaintext = await fs.readFile(args.absolutePath);
    const sha256 = createSha256(plaintext);
    const objectId = sha256;
    await this.writeObjectIfMissing(
      args.stellaHomePath,
      objectId,
      plaintext,
      args.encryptionKey,
    );
    return {
      scope: args.scope,
      path: normalizePath(args.manifestPath),
      sha256,
      objectId,
      size: stat.size,
      mode: stat.mode & 0o777,
      mtimeMs: stat.mtimeMs,
    };
  }

  private async writeObjectIfMissing(
    stellaHomePath: string,
    objectId: string,
    plaintext: Buffer,
    key: Buffer,
  ) {
    const objectMetaPath = this.getObjectMetadataPath(stellaHomePath, objectId);
    const objectCiphertextPath = this.getObjectCiphertextPath(
      stellaHomePath,
      objectId,
    );
    if (
      (await fileExists(objectMetaPath)) &&
      (await fileExists(objectCiphertextPath))
    ) {
      return;
    }
    const encrypted = createEncryptedObject(key, plaintext);
    await ensurePrivateDir(path.dirname(objectMetaPath));
    await fs.writeFile(objectCiphertextPath, encrypted.ciphertext, {
      mode: 0o600,
    });
    await writePrivateFile(
      objectMetaPath,
      JSON.stringify(encrypted.metadata, null, 2),
    );
  }

  private async loadOrCreateEncryptionKey(
    stellaHomePath: string,
  ): Promise<BackupKeyMaterial> {
    const configPath = this.getBackupConfigPath(stellaHomePath);
    const existing = await readJsonFile<BackupConfig>(configPath);
    const restored = existing?.wrappedKey
      ? unprotectValue(ENCRYPTION_SCOPE, existing.wrappedKey)
      : null;
    if (restored) {
      const key = Buffer.from(restored, "base64url");
      if (key.byteLength === KEY_BYTES) {
        const fingerprint =
          existing?.keyFingerprint?.trim() || this.createKeyFingerprint(key);
        const existingWrappedKey = existing?.wrappedKey;
        if (existingWrappedKey && existing?.keyFingerprint !== fingerprint) {
          await this.persistBackupConfig(stellaHomePath, {
            version: BACKUP_VERSION,
            wrappedKey: existingWrappedKey,
            updatedAt: existing?.updatedAt ?? Date.now(),
            hostname: existing?.hostname || os.hostname(),
            keyFingerprint: fingerprint,
          });
        }
        return {
          key,
          fingerprint,
          hostname: existing?.hostname || os.hostname(),
        };
      }
    }

    const key = crypto.randomBytes(KEY_BYTES);
    return await this.persistEncryptionKey(stellaHomePath, key);
  }

  private createKeyFingerprint(key: Buffer) {
    return createSha256(key);
  }

  private async persistBackupConfig(
    stellaHomePath: string,
    config: BackupConfig,
  ) {
    await writePrivateFile(
      this.getBackupConfigPath(stellaHomePath),
      JSON.stringify(config, null, 2),
    );
  }

  private async resetLocalBackupCache(stellaHomePath: string) {
    for (const child of ["objects", "manifests", "tmp"]) {
      await fs
        .rm(path.join(this.getBackupsRoot(stellaHomePath), child), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
    }
  }

  private async persistEncryptionKey(
    stellaHomePath: string,
    key: Buffer,
    _snapshotId?: string,
  ): Promise<BackupKeyMaterial> {
    const wrappedKey = protectValue(
      ENCRYPTION_SCOPE,
      key.toString("base64url"),
    );
    const fingerprint = this.createKeyFingerprint(key);
    const nextConfig: BackupConfig = {
      version: BACKUP_VERSION,
      wrappedKey,
      updatedAt: Date.now(),
      hostname: os.hostname(),
      keyFingerprint: fingerprint,
    };
    const existing = await readJsonFile<BackupConfig>(
      this.getBackupConfigPath(stellaHomePath),
    );
    const previousWrappedKey = existing?.wrappedKey;
    if (
      existing?.keyFingerprint
      && existing.keyFingerprint !== nextConfig.keyFingerprint
    ) {
      await this.resetLocalBackupCache(stellaHomePath);
    }
    await this.persistBackupConfig(stellaHomePath, nextConfig);
    if (previousWrappedKey && previousWrappedKey !== wrappedKey) {
      deleteProtectedValue(ENCRYPTION_SCOPE, previousWrappedKey);
    }
    return {
      key,
      fingerprint,
      hostname: nextConfig.hostname,
    };
  }

  private async createRemoteServiceRequest(
    servicePath: string,
  ): Promise<RemoteServiceRequest> {
    const baseUrl = this.deps.getConvexSiteUrl()?.trim();
    const deviceId = this.deps.getDeviceId()?.trim();
    const token = await this.deps.getAuthToken();
    if (!baseUrl) {
      throw new Error("Remote backup is unavailable because the Convex site URL is missing.");
    }
    if (!deviceId) {
      throw new Error("Remote backup is unavailable because this device has no device ID.");
    }
    if (!token?.trim()) {
      throw new Error("Sign in to use remote backups.");
    }
    const endpoint = new URL(
      servicePath.startsWith("/") ? servicePath : `/${servicePath}`,
      baseUrl,
    ).toString();
    return {
      endpoint,
      deviceId,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "X-Device-ID": deviceId,
      },
    };
  }

  private async fetchRemoteJson<T>(
    endpoint: string,
    init: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REMOTE_FETCH_TIMEOUT_MS);
    const headers = new Headers(init.headers ?? {});
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    try {
      const response = await fetch(endpoint, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as { error?: string };
          throw new Error(parsed.error || text || "Remote backup request failed.");
        } catch {
          throw new Error(text || "Remote backup request failed.");
        }
      }
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Remote backup request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async downloadBinary(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REMOTE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to download backup object (${response.status}).`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Backup download timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uploadManifestRemote(
    stellaHomePath: string,
    manifest: BackupManifest,
    keyMaterial: BackupKeyMaterial,
  ): Promise<boolean> {
    const keyRequest = await this.createRemoteServiceRequest(
      REMOTE_BACKUP_KEY_PATH,
    );
    const keyStatus = await this.fetchRemoteJson<RemoteKeyEnsureResponse>(
      keyRequest.endpoint,
      {
        method: "POST",
        headers: keyRequest.headers,
        body: JSON.stringify({
          keyBase64Url: keyMaterial.key.toString("base64url"),
          keyFingerprint: keyMaterial.fingerprint,
        }),
      },
    );
    if (keyStatus.status === "mismatch") {
      throw new Error(
        "This account already has backups encrypted with a different key. Restore an existing remote backup on this device before uploading new backups.",
      );
    }

    const objectIds = [...new Set(manifest.entries.map((entry) => entry.objectId))];
    const objects = await Promise.all(
      objectIds.map(async (objectId) => {
        const metadata = await readJsonFile<BackupObjectMetadata>(
          this.getObjectMetadataPath(stellaHomePath, objectId),
        );
        if (!metadata) {
          throw new Error(`Missing local backup metadata for object ${objectId}.`);
        }
        return {
          objectId,
          plaintextSha256: metadata.plaintextSha256,
          plaintextSize: metadata.plaintextSize,
          algorithm: metadata.algorithm,
          ivBase64Url: metadata.ivBase64Url,
          authTagBase64Url: metadata.authTagBase64Url,
        };
      }),
    );

    const prepareRequest = await this.createRemoteServiceRequest(
      REMOTE_BACKUP_PREPARE_UPLOAD_PATH,
    );
    const prepare = await this.fetchRemoteJson<RemotePrepareUploadResponse>(
      prepareRequest.endpoint,
      {
        method: "POST",
        headers: prepareRequest.headers,
        body: JSON.stringify({
          snapshotId: manifest.snapshotId,
          snapshotHash: manifest.snapshotHash,
          createdAt: manifest.createdAt,
          objects,
        }),
      },
    );

    for (const remoteObject of prepare.missingObjects) {
      const ciphertext = await fs.readFile(
        this.getObjectCiphertextPath(stellaHomePath, remoteObject.objectId),
      );
      const response = await fetch(remoteObject.uploadUrl, {
        method: "PUT",
        body: ciphertext,
        headers: {
          "Content-Type": "application/octet-stream",
        },
      });
      if (!response.ok) {
        throw new Error(
          `Failed to upload backup object ${remoteObject.objectId} (${response.status}).`,
        );
      }
    }

    const manifestEncrypted = createEncryptedObject(
      keyMaterial.key,
      Buffer.from(JSON.stringify(manifest), "utf8"),
    );
    const manifestUploadResponse = await fetch(prepare.manifest.uploadUrl, {
      method: "PUT",
      body: manifestEncrypted.ciphertext,
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });
    if (!manifestUploadResponse.ok) {
      throw new Error(
        `Failed to upload backup manifest (${manifestUploadResponse.status}).`,
      );
    }

    const finalizeRequest = await this.createRemoteServiceRequest(
      REMOTE_BACKUP_FINALIZE_UPLOAD_PATH,
    );
    await this.fetchRemoteJson<{ snapshotId: string; isLatest: boolean }>(
      finalizeRequest.endpoint,
      {
        method: "POST",
        headers: finalizeRequest.headers,
        body: JSON.stringify({
          snapshotId: manifest.snapshotId,
          snapshotHash: manifest.snapshotHash,
          createdAt: manifest.createdAt,
          sourceHostname: keyMaterial.hostname,
          version: manifest.version,
          entryCount: manifest.entries.length,
          objectCount: objectIds.length,
          markLatest: true,
          manifest: {
            r2Key: prepare.manifest.r2Key,
            plaintextSha256: manifestEncrypted.metadata.plaintextSha256,
            plaintextSize: manifestEncrypted.metadata.plaintextSize,
            algorithm: manifestEncrypted.metadata.algorithm,
            ivBase64Url: manifestEncrypted.metadata.ivBase64Url,
            authTagBase64Url: manifestEncrypted.metadata.authTagBase64Url,
          },
          uploadedObjects: prepare.missingObjects.map((remoteObject) => {
            const localObject = objects.find(
              (candidate) => candidate.objectId === remoteObject.objectId,
            );
            if (!localObject) {
              throw new Error(
                `Missing local metadata for uploaded object ${remoteObject.objectId}.`,
              );
            }
            return {
              ...localObject,
              r2Key: remoteObject.r2Key,
            };
          }),
        }),
      },
    );
    await this.writeStatus(stellaHomePath, (current) => ({
      ...current,
      enabled: current.enabled,
      lastRemoteSuccessAt: Date.now(),
      lastRemoteManifestId: manifest.snapshotId,
      lastRemoteError: undefined,
    }));
    return true;
  }

  private getRepoExcludePrefixes(stellaHomePath: string) {
    const relativeHome = normalizePath(
      path.relative(this.deps.stellaRoot, stellaHomePath),
    );
    return relativeHome && !relativeHome.startsWith("..")
      ? [
          normalizePath(path.posix.join(relativeHome, "state")),
          normalizePath(path.posix.join(relativeHome, "workspace")),
        ]
      : [];
  }

  private async ensureRepoRestoreSafe(stellaHomePath: string) {
    const excludePrefixes = this.getRepoExcludePrefixes(stellaHomePath);
    const porcelain = await runGit(this.deps.stellaRoot, ["status", "--porcelain", "-z"]);
    const entries = porcelain
      .toString("utf8")
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => normalizePath(value.slice(3).trim()))
      .filter((relativePath) => {
        if (!relativePath) {
          return false;
        }
        return !excludePrefixes.some(
          (prefix) =>
            relativePath === prefix || relativePath.startsWith(`${prefix}/`),
        );
      });
    if (entries.length > 0) {
      throw new Error(
        "Restore requires a clean repo working tree. Commit or stash your repo changes first.",
      );
    }
  }

  private async applyRestoreFromManifest(args: {
    stellaHomePath: string;
    manifest: BackupManifest;
    stagedObjectsDir: string;
  }) {
    const repoEntries = args.manifest.entries.filter(
      (entry) => entry.scope === "repo-worktree",
    );
    const stateEntries = args.manifest.entries.filter(
      (entry) => entry.scope === "state",
    );
    const workspaceEntries = args.manifest.entries.filter(
      (entry) => entry.scope === "workspace",
    );
    const sqliteEntry =
      args.manifest.entries.find((entry) => entry.scope === "sqlite") ?? null;
    const repoBundleEntry =
      args.manifest.entries.find((entry) => entry.scope === "repo-git-bundle")
      ?? null;

    await this.restoreRepoWorkingTree(
      args.stagedObjectsDir,
      args.stellaHomePath,
      repoEntries,
    );
    await this.restoreScopedDirectory({
      rootPath: path.join(args.stellaHomePath, "workspace"),
      entries: workspaceEntries,
      stagedObjectsDir: args.stagedObjectsDir,
      shouldSkip: () => false,
    });
    await this.restoreScopedDirectory({
      rootPath: path.join(args.stellaHomePath, "state"),
      entries: stateEntries.filter((entry) => !isPreservedStatePath(entry.path.slice("state/".length))),
      stagedObjectsDir: args.stagedObjectsDir,
      shouldSkip: shouldSkipStatePath,
    });

    if (repoBundleEntry) {
      const restoredBundlePath = path.join(
        this.getBackupsRoot(args.stellaHomePath),
        "restored",
        args.manifest.snapshotId,
        "repo.bundle",
      );
      await this.restoreEntryToPath(
        repoBundleEntry,
        restoredBundlePath,
        args.stagedObjectsDir,
      );
    }

    if (sqliteEntry) {
      const sqliteTarget = path.join(args.stellaHomePath, "state", "stella.sqlite");
      await ensurePrivateDir(path.dirname(sqliteTarget));
      await removeFileIfExists(`${sqliteTarget}-shm`);
      await removeFileIfExists(`${sqliteTarget}-wal`);
      await removeFileIfExists(sqliteTarget);
      await this.restoreEntryToPath(sqliteEntry, sqliteTarget, args.stagedObjectsDir);
    }
  }

  private async restoreRepoWorkingTree(
    stagedObjectsDir: string,
    stellaHomePath: string,
    entries: BackupManifestEntry[],
  ) {
    const excludePrefixes = this.getRepoExcludePrefixes(stellaHomePath);
    const currentFiles = await listGitWorkingTreeFiles(
      this.deps.stellaRoot,
      excludePrefixes,
    );
    const snapshotFiles = new Set(entries.map((entry) => normalizePath(entry.path)));
    await Promise.all(
      currentFiles
        .filter((relativePath) => !snapshotFiles.has(relativePath))
        .map(async (relativePath) => {
          await removeFileIfExists(
            resolveInsideRoot(this.deps.stellaRoot, relativePath),
          );
        }),
    );
    for (const entry of entries) {
      await this.restoreEntryToPath(
        entry,
        resolveInsideRoot(this.deps.stellaRoot, entry.path),
        stagedObjectsDir,
      );
    }
  }

  private async restoreScopedDirectory(args: {
    rootPath: string;
    entries: BackupManifestEntry[];
    stagedObjectsDir: string;
    shouldSkip: (relativePath: string, isDirectory: boolean) => boolean;
  }) {
    await ensurePrivateDir(args.rootPath);
    const scopePrefix = path.basename(args.rootPath);
    const snapshotEntries = args.entries.map((entry) => ({
      ...entry,
      relativePath: normalizePath(entry.path.slice(`${scopePrefix}/`.length)),
    }));
    const snapshotPaths = new Set(snapshotEntries.map((entry) => entry.relativePath));
    const currentFiles = await walkFiles(args.rootPath, args.shouldSkip);
    await Promise.all(
      currentFiles
        .filter((relativePath) => !snapshotPaths.has(normalizePath(relativePath)))
        .map(async (relativePath) => {
          await removeFileIfExists(resolveInsideRoot(args.rootPath, relativePath));
        }),
    );
    for (const entry of snapshotEntries) {
      await this.restoreEntryToPath(
        entry,
        resolveInsideRoot(args.rootPath, entry.relativePath),
        args.stagedObjectsDir,
      );
    }
  }

  private async restoreEntryToPath(
    entry: BackupManifestEntry,
    targetPath: string,
    stagedObjectsDir: string,
  ) {
    const sourcePath = path.join(stagedObjectsDir, entry.objectId);
    const plaintext = await fs.readFile(sourcePath);
    if (createSha256(plaintext) !== entry.sha256) {
      throw new Error(`Backup entry integrity check failed for ${entry.path}.`);
    }
    await ensurePrivateDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, plaintext, {
      mode: 0o600,
    });
    if (typeof entry.mode === "number") {
      await fs.chmod(targetPath, entry.mode).catch(() => undefined);
    }
    if (typeof entry.mtimeMs === "number" && Number.isFinite(entry.mtimeMs)) {
      const mtime = new Date(entry.mtimeMs);
      await fs.utimes(targetPath, mtime, mtime).catch(() => undefined);
    }
  }

  private async readStatus(stellaHomePath: string): Promise<BackupStatus> {
    return (
      (await readJsonFile<BackupStatus>(
        this.getStatusPath(stellaHomePath),
      )) ?? {
        version: BACKUP_VERSION,
        enabled: false,
      }
    );
  }

  private async writeStatus(
    stellaHomePath: string,
    update: (current: BackupStatus) => BackupStatus,
  ) {
    const next = update(await this.readStatus(stellaHomePath));
    next.version = BACKUP_VERSION;
    await writePrivateFile(
      this.getStatusPath(stellaHomePath),
      JSON.stringify(next, null, 2),
    );
  }

  private async readSyncMode(stellaHomePath: string): Promise<"on" | "off"> {
    const prefs = await readJsonFile<{ syncMode?: string }>(
      path.join(stellaHomePath, "state", "preferences.json"),
    );
    return prefs?.syncMode === "on" ? "on" : "off";
  }

  private getBackupsRoot(stellaHomePath: string) {
    return path.join(stellaHomePath, "state", "backups");
  }

  private getBackupConfigPath(stellaHomePath: string) {
    return path.join(this.getBackupsRoot(stellaHomePath), "config.json");
  }

  private getStatusPath(stellaHomePath: string) {
    return path.join(this.getBackupsRoot(stellaHomePath), "status.json");
  }

  private getObjectMetadataPath(stellaHomePath: string, objectId: string) {
    return path.join(
      this.getBackupsRoot(stellaHomePath),
      "objects",
      `${objectId}.json`,
    );
  }

  private getObjectCiphertextPath(stellaHomePath: string, objectId: string) {
    return path.join(
      this.getBackupsRoot(stellaHomePath),
      "objects",
      `${objectId}.bin`,
    );
  }
}
