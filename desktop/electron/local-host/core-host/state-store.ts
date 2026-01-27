import { promises as fs } from "fs";
import path from "path";

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const readJson = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeJson = async (filePath: string, value: unknown) => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
};

export type ActiveChangeSet = {
  id: string;
  scope: string;
  startedAt: number;
  agentType: string;
};

export type BaselineMetadata = {
  baselineId: string;
  createdAt: number;
  sourceChangeSetId?: string;
  sourceScope?: string;
  snapshotPath: string;
  gitHead?: string | null;
  packs?: Array<{ packId: string; version: string; status: string }>;
};

type BootStatus = {
  bootId: string;
  startedAt: number;
  healthyAt?: number;
  status: "starting" | "healthy" | "failed";
  failureReason?: string;
  safeModeApplied?: boolean;
};

export class StateStore {
  readonly stateRoot: string;
  readonly packsRoot: string;

  readonly changesetsDir: string;
  readonly baselineDir: string;
  readonly baselineSnapshotsDir: string;
  readonly packsStateDir: string;
  readonly packsUninstallDir: string;
  readonly updatesDir: string;
  readonly safeModeDir: string;
  readonly startupDir: string;
  readonly signingDir: string;

  private readonly activeChangeSetPath: string;
  private readonly baselineMetadataPath: string;
  private readonly baselineHistoryPath: string;
  private readonly packInstallationsPath: string;
  private readonly safeModeTriggerPath: string;
  private readonly bootStatusPath: string;

  constructor(options: { stateRoot: string; packsRoot: string }) {
    this.stateRoot = options.stateRoot;
    this.packsRoot = options.packsRoot;

    this.changesetsDir = path.join(this.stateRoot, "changesets");
    this.baselineDir = path.join(this.stateRoot, "baseline");
    this.baselineSnapshotsDir = path.join(this.baselineDir, "snapshots");
    this.packsStateDir = path.join(this.stateRoot, "packs");
    this.packsUninstallDir = path.join(this.packsStateDir, "uninstall");
    this.updatesDir = path.join(this.stateRoot, "updates");
    this.safeModeDir = path.join(this.stateRoot, "safe-mode");
    this.startupDir = path.join(this.stateRoot, "startup");
    this.signingDir = path.join(this.stateRoot, "signing");

    this.activeChangeSetPath = path.join(this.changesetsDir, "active.json");
    this.baselineMetadataPath = path.join(this.baselineDir, "last_known_good.json");
    this.baselineHistoryPath = path.join(this.baselineDir, "history.json");
    this.packInstallationsPath = path.join(this.packsStateDir, "installations.json");
    this.safeModeTriggerPath = path.join(this.safeModeDir, "trigger.json");
    this.bootStatusPath = path.join(this.startupDir, "boot.json");
  }

  async ensureStructure() {
    await ensureDir(this.stateRoot);
    await ensureDir(this.changesetsDir);
    await ensureDir(this.baselineDir);
    await ensureDir(this.baselineSnapshotsDir);
    await ensureDir(this.packsStateDir);
    await ensureDir(this.packsUninstallDir);
    await ensureDir(this.updatesDir);
    await ensureDir(this.safeModeDir);
    await ensureDir(this.startupDir);
    await ensureDir(this.signingDir);
    await ensureDir(this.packsRoot);
    await ensureDir(path.join(this.packsRoot, "bundles"));
    await ensureDir(path.join(this.packsRoot, "cache"));
  }

  getChangeSetDir(id: string) {
    return path.join(this.changesetsDir, id);
  }

  getChangeSetRecordPath(id: string) {
    return path.join(this.getChangeSetDir(id), "record.json");
  }

  getChangeSetBaselinePath(id: string) {
    return path.join(this.getChangeSetDir(id), "baseline.snapshot.json");
  }

  async setActiveChangeSet(value: ActiveChangeSet | null) {
    if (!value) {
      try {
        await fs.rm(this.activeChangeSetPath, { force: true });
      } catch {
        // Ignore.
      }
      return;
    }
    await writeJson(this.activeChangeSetPath, value);
  }

  async getActiveChangeSet(): Promise<ActiveChangeSet | null> {
    const active = await readJson<ActiveChangeSet | null>(this.activeChangeSetPath, null);
    return active;
  }

  async saveChangeSetRecord<T>(id: string, record: T) {
    await ensureDir(this.getChangeSetDir(id));
    await writeJson(this.getChangeSetRecordPath(id), record);
  }

  async loadChangeSetRecord<T>(id: string): Promise<T | null> {
    const filePath = this.getChangeSetRecordPath(id);
    try {
      await fs.access(filePath);
    } catch {
      return null;
    }
    return await readJson<T | null>(filePath, null);
  }

  async saveChangeSetBaseline(id: string, snapshot: unknown) {
    await ensureDir(this.getChangeSetDir(id));
    await writeJson(this.getChangeSetBaselinePath(id), snapshot);
  }

  async loadChangeSetBaseline<T>(id: string): Promise<T | null> {
    const filePath = this.getChangeSetBaselinePath(id);
    try {
      await fs.access(filePath);
    } catch {
      return null;
    }
    return await readJson<T | null>(filePath, null);
  }

  async listChangeSetIds() {
    try {
      const entries = await fs.readdir(this.changesetsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [] as string[];
    }
  }

  async saveBaselineMetadata(metadata: BaselineMetadata) {
    await writeJson(this.baselineMetadataPath, metadata);
    const history = await readJson<BaselineMetadata[]>(this.baselineHistoryPath, []);
    const next = [metadata, ...history].slice(0, 50);
    await writeJson(this.baselineHistoryPath, next);
  }

  async loadBaselineMetadata() {
    return await readJson<BaselineMetadata | null>(this.baselineMetadataPath, null);
  }

  async loadBaselineHistory() {
    return await readJson<BaselineMetadata[]>(this.baselineHistoryPath, []);
  }

  getBaselineSnapshotPath(baselineId: string) {
    return path.join(this.baselineSnapshotsDir, `${baselineId}.snapshot.json`);
  }

  async saveBaselineSnapshot(baselineId: string, snapshot: unknown) {
    await writeJson(this.getBaselineSnapshotPath(baselineId), snapshot);
  }

  async loadBaselineSnapshot<T>(baselineId: string): Promise<T | null> {
    const snapshotPath = this.getBaselineSnapshotPath(baselineId);
    try {
      await fs.access(snapshotPath);
    } catch {
      return null;
    }
    return await readJson<T | null>(snapshotPath, null);
  }

  async loadPackInstallations<T>() {
    return await readJson<T[]>(this.packInstallationsPath, []);
  }

  async savePackInstallations<T>(installations: T[]) {
    await writeJson(this.packInstallationsPath, installations);
  }

  getPackUninstallSnapshotPath(installId: string) {
    return path.join(this.packsUninstallDir, `${installId}.snapshot.json`);
  }

  async savePackUninstallSnapshot(installId: string, snapshot: unknown) {
    await writeJson(this.getPackUninstallSnapshotPath(installId), snapshot);
  }

  async loadPackUninstallSnapshot<T>(installId: string) {
    return await readJson<T | null>(this.getPackUninstallSnapshotPath(installId), null);
  }

  async setSafeModeTrigger(payload: { reason: string; createdAt: number } | null) {
    if (!payload) {
      try {
        await fs.rm(this.safeModeTriggerPath, { force: true });
      } catch {
        // Ignore.
      }
      return;
    }
    await writeJson(this.safeModeTriggerPath, payload);
  }

  async getSafeModeTrigger() {
    return await readJson<{ reason: string; createdAt: number } | null>(
      this.safeModeTriggerPath,
      null,
    );
  }

  async startBoot() {
    const boot: BootStatus = {
      bootId: crypto.randomUUID(),
      startedAt: Date.now(),
      status: "starting",
    };
    await writeJson(this.bootStatusPath, boot);
    return boot;
  }

  async getLastBootStatus() {
    return await readJson<BootStatus | null>(this.bootStatusPath, null);
  }

  async markBootHealthy(bootId: string) {
    const current = await this.getLastBootStatus();
    if (!current || current.bootId !== bootId) {
      return;
    }
    const next: BootStatus = {
      ...current,
      status: "healthy",
      healthyAt: Date.now(),
    };
    await writeJson(this.bootStatusPath, next);
  }

  async markBootFailed(bootId: string, reason: string, safeModeApplied: boolean) {
    const current = await this.getLastBootStatus();
    if (!current || current.bootId !== bootId) {
      return;
    }
    const next: BootStatus = {
      ...current,
      status: "failed",
      failureReason: reason,
      safeModeApplied,
    };
    await writeJson(this.bootStatusPath, next);
  }
}
