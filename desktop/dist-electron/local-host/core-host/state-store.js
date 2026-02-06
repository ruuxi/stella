import { promises as fs } from "fs";
import path from "path";
const ensureDir = async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
};
const readJson = async (filePath, fallback) => {
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
};
const writeJson = async (filePath, value) => {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
};
export class StateStore {
    constructor(options) {
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
    getChangeSetDir(id) {
        return path.join(this.changesetsDir, id);
    }
    getChangeSetRecordPath(id) {
        return path.join(this.getChangeSetDir(id), "record.json");
    }
    getChangeSetBaselinePath(id) {
        return path.join(this.getChangeSetDir(id), "baseline.snapshot.json");
    }
    async setActiveChangeSet(value) {
        if (!value) {
            try {
                await fs.rm(this.activeChangeSetPath, { force: true });
            }
            catch {
                // Ignore.
            }
            return;
        }
        await writeJson(this.activeChangeSetPath, value);
    }
    async getActiveChangeSet() {
        const active = await readJson(this.activeChangeSetPath, null);
        return active;
    }
    async saveChangeSetRecord(id, record) {
        await ensureDir(this.getChangeSetDir(id));
        await writeJson(this.getChangeSetRecordPath(id), record);
    }
    async loadChangeSetRecord(id) {
        const filePath = this.getChangeSetRecordPath(id);
        try {
            await fs.access(filePath);
        }
        catch {
            return null;
        }
        return await readJson(filePath, null);
    }
    async saveChangeSetBaseline(id, snapshot) {
        await ensureDir(this.getChangeSetDir(id));
        await writeJson(this.getChangeSetBaselinePath(id), snapshot);
    }
    async loadChangeSetBaseline(id) {
        const filePath = this.getChangeSetBaselinePath(id);
        try {
            await fs.access(filePath);
        }
        catch {
            return null;
        }
        return await readJson(filePath, null);
    }
    async listChangeSetIds() {
        try {
            const entries = await fs.readdir(this.changesetsDir, { withFileTypes: true });
            return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        }
        catch {
            return [];
        }
    }
    async saveBaselineMetadata(metadata) {
        await writeJson(this.baselineMetadataPath, metadata);
        const history = await readJson(this.baselineHistoryPath, []);
        const next = [metadata, ...history].slice(0, 50);
        await writeJson(this.baselineHistoryPath, next);
    }
    async loadBaselineMetadata() {
        return await readJson(this.baselineMetadataPath, null);
    }
    async loadBaselineHistory() {
        return await readJson(this.baselineHistoryPath, []);
    }
    getBaselineSnapshotPath(baselineId) {
        return path.join(this.baselineSnapshotsDir, `${baselineId}.snapshot.json`);
    }
    async saveBaselineSnapshot(baselineId, snapshot) {
        await writeJson(this.getBaselineSnapshotPath(baselineId), snapshot);
    }
    async loadBaselineSnapshot(baselineId) {
        const snapshotPath = this.getBaselineSnapshotPath(baselineId);
        try {
            await fs.access(snapshotPath);
        }
        catch {
            return null;
        }
        return await readJson(snapshotPath, null);
    }
    async loadPackInstallations() {
        return await readJson(this.packInstallationsPath, []);
    }
    async savePackInstallations(installations) {
        await writeJson(this.packInstallationsPath, installations);
    }
    getPackUninstallSnapshotPath(installId) {
        return path.join(this.packsUninstallDir, `${installId}.snapshot.json`);
    }
    async savePackUninstallSnapshot(installId, snapshot) {
        await writeJson(this.getPackUninstallSnapshotPath(installId), snapshot);
    }
    async loadPackUninstallSnapshot(installId) {
        return await readJson(this.getPackUninstallSnapshotPath(installId), null);
    }
    async setSafeModeTrigger(payload) {
        if (!payload) {
            try {
                await fs.rm(this.safeModeTriggerPath, { force: true });
            }
            catch {
                // Ignore.
            }
            return;
        }
        await writeJson(this.safeModeTriggerPath, payload);
    }
    async getSafeModeTrigger() {
        return await readJson(this.safeModeTriggerPath, null);
    }
    async startBoot() {
        const boot = {
            bootId: crypto.randomUUID(),
            startedAt: Date.now(),
            status: "starting",
        };
        await writeJson(this.bootStatusPath, boot);
        return boot;
    }
    async getLastBootStatus() {
        return await readJson(this.bootStatusPath, null);
    }
    async markBootHealthy(bootId) {
        const current = await this.getLastBootStatus();
        if (!current || current.bootId !== bootId) {
            return;
        }
        const next = {
            ...current,
            status: "healthy",
            healthyAt: Date.now(),
        };
        await writeJson(this.bootStatusPath, next);
    }
    async markBootFailed(bootId, reason, safeModeApplied) {
        const current = await this.getLastBootStatus();
        if (!current || current.bootId !== bootId) {
            return;
        }
        const next = {
            ...current,
            status: "failed",
            failureReason: reason,
            safeModeApplied,
        };
        await writeJson(this.bootStatusPath, next);
    }
}
