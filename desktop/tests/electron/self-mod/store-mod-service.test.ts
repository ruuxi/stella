import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", async () => {
  const { DatabaseSync } = await import("node:sqlite");

  class BetterSqlite3Mock {
    private readonly db: InstanceType<typeof DatabaseSync>;

    constructor(filePath: string, options?: { readonly?: boolean }) {
      this.db = new DatabaseSync(filePath, {
        readOnly: options?.readonly === true,
      });
    }

    exec(sql: string) {
      this.db.exec(sql);
    }

    prepare(sql: string) {
      return this.db.prepare(sql);
    }

    close() {
      this.db.close();
    }
  }

  return { default: BetterSqlite3Mock };
});

import { createDesktopDatabase } from "../../../electron/storage/database.js";
import { StoreModStore } from "../../../electron/storage/store-mod-store.js";
import { StoreModService } from "../../../electron/self-mod/store-mod-service.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
} from "../../../src/shared/contracts/electron-data.js";

const tempDirs: string[] = [];
const openDatabases = new Set<{ close(): void }>();

const createTempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const runGit = (repoRoot: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const writeFile = (repoRoot: string, relativePath: string, content: string) => {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
};

const createServiceHarness = () => {
  const stellaHome = createTempDir("stella-store-home-");
  const repoRoot = createTempDir("stella-store-repo-");
  const db = createDesktopDatabase(stellaHome);
  openDatabases.add(db);
  const store = new StoreModStore(db);
  const service = new StoreModService(repoRoot, store);

  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["config", "user.email", "stella@example.com"]);
  runGit(repoRoot, ["config", "user.name", "Stella"]);

  writeFile(repoRoot, "package.json", JSON.stringify({ name: "stella-store-test" }, null, 2));
  writeFile(repoRoot, "src/existing.ts", "export const existing = 1;\n");
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", "Initial commit"]);

  return {
    repoRoot,
    store,
    service,
    close: () => {
      if (openDatabases.has(db)) {
        openDatabases.delete(db);
        db.close();
      }
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  for (const db of openDatabases) {
    db.close();
  }
  openDatabases.clear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("StoreModService", () => {
  it("commits only newly changed files and records overlapping dirty files as blocked", async () => {
    const { repoRoot, service, close } = createServiceHarness();

    writeFile(repoRoot, "src/existing.ts", "export const existing = 2;\n");

    const feature = await service.beginSelfModRun({
      runId: "run-1",
      taskDescription: "Add widget",
    });

    writeFile(repoRoot, "src/existing.ts", "export const existing = 3;\n");
    writeFile(repoRoot, "src/new.ts", "export const created = true;\n");

    const batch = await service.finalizeSelfModRun({
      runId: "run-1",
      succeeded: true,
    });

    expect(batch).not.toBeNull();
    expect(batch?.featureId).toBe(feature.featureId);
    expect(batch?.state).toBe("committed");
    expect(batch?.files).toEqual(["src/new.ts"]);
    expect(batch?.blockedFiles).toEqual(["src/existing.ts"]);
    expect(batch?.commitHash).toBeTruthy();

    const subject = runGit(repoRoot, ["log", "-1", "--pretty=%s"]);
    expect(subject).toContain(`[feature:${feature.featureId}]`);

    close();
  });

  it("defaults to the contiguous unpublished range and still allows explicit noncontiguous batch selection", () => {
    const { store, service, close } = createServiceHarness();

    store.upsertFeature({
      featureId: "feature:weather-widget",
      name: "Weather Widget",
      description: "A test feature",
    });

    store.createBatch({
      batchId: "batch-1",
      featureId: "feature:weather-widget",
      ordinal: 1,
      state: "published",
      commitHash: "hash-1",
      files: ["src/one.ts"],
      packageId: "weather-widget",
      releaseNumber: 1,
    });
    store.createBatch({
      batchId: "batch-2",
      featureId: "feature:weather-widget",
      ordinal: 2,
      state: "committed",
      commitHash: "hash-2",
      files: ["src/two.ts"],
    });
    store.createBatch({
      batchId: "batch-3",
      featureId: "feature:weather-widget",
      ordinal: 3,
      state: "blocked",
      files: ["src/three.ts"],
      blockedFiles: ["src/three.ts"],
    });
    store.createBatch({
      batchId: "batch-4",
      featureId: "feature:weather-widget",
      ordinal: 4,
      state: "committed",
      commitHash: "hash-4",
      files: ["src/four.ts"],
    });

    const defaultDraft = service.createReleaseDraft({
      featureId: "feature:weather-widget",
    });
    expect(defaultDraft.selectedBatchIds).toEqual(["batch-2"]);

    const explicitDraft = service.createReleaseDraft({
      featureId: "feature:weather-widget",
      batchIds: ["batch-4", "batch-2"],
    });
    expect(explicitDraft.selectedBatchIds).toEqual(["batch-2", "batch-4"]);

    close();
  });

  it("publishes a blueprint artifact built from selected batches", async () => {
    const { repoRoot, service, store, close } = createServiceHarness();

    await service.beginSelfModRun({
      runId: "run-blueprint-1",
      taskDescription: "Weather widget",
    });
    writeFile(repoRoot, "src/weather-one.ts", "export const weatherOne = 1;\n");
    const firstBatch = await service.finalizeSelfModRun({
      runId: "run-blueprint-1",
      succeeded: true,
    });

    await service.beginSelfModRun({
      runId: "run-blueprint-2",
      taskDescription: "Weather widget",
    });
    writeFile(repoRoot, "src/weather-two.ts", "export const weatherTwo = 2;\n");
    const secondBatch = await service.finalizeSelfModRun({
      runId: "run-blueprint-2",
      succeeded: true,
    });

    expect(firstBatch?.commitHash).toBeTruthy();
    expect(secondBatch?.commitHash).toBeTruthy();

    let capturedArtifact: StoreReleaseArtifact | null = null;
    let capturedManifest: StorePackageReleaseRecord["manifest"] | null = null;

    await service.publishRelease({
      featureId: firstBatch!.featureId,
      packageId: "weather-widget",
      releaseNumber: 1,
      displayName: "Weather Widget",
      description: "Blueprint publish test",
      publish: async (args) => {
        capturedArtifact = args.artifact;
        capturedManifest = {
          ...args.manifest,
          releaseNumber: 1,
        };
        return {
          packageId: args.packageId,
          releaseNumber: 1,
          manifest: {
            ...args.manifest,
            releaseNumber: 1,
          },
          storageKey: "storage:weather-widget:1",
          createdAt: Date.now(),
        };
      },
    });

    expect(capturedArtifact?.kind).toBe("self_mod_blueprint");
    expect(capturedArtifact?.schemaVersion).toBe(1);
    expect(capturedArtifact?.manifest.releaseNumber).toBe(1);
    expect(capturedArtifact?.batches).toHaveLength(2);
    expect(capturedArtifact?.batches[0]?.patch).toContain("weather-one.ts");
    expect(capturedArtifact?.files.map((file) => file.path).sort()).toEqual([
      "src/weather-one.ts",
      "src/weather-two.ts",
    ]);
    expect(capturedManifest?.batchIds).toEqual([firstBatch!.batchId, secondBatch!.batchId]);
    expect(
      store.listBatches(firstBatch!.featureId).map((batch) => batch.state),
    ).toEqual(["published", "published"]);

    close();
  });

  it("records store install commits through the self-mod lifecycle", async () => {
    const { repoRoot, service, close } = createServiceHarness();

    const packageRecord: StorePackageRecord = {
      packageId: "weather-widget",
      featureId: "weather-widget-store",
      displayName: "Weather Widget",
      description: "Install flow test",
      latestReleaseNumber: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const releaseRecord: StorePackageReleaseRecord = {
      packageId: "weather-widget",
      releaseNumber: 1,
      manifest: {
        packageId: "weather-widget",
        featureId: "weather-widget-store",
        releaseNumber: 1,
        displayName: "Weather Widget",
        description: "Install flow test",
        batchIds: ["batch:published:1"],
        commitHashes: ["published-commit-1"],
        files: ["src/installed.ts"],
        createdAt: Date.now(),
      },
      storageKey: "storage:weather-widget:1",
      createdAt: Date.now(),
    };
    const artifact: StoreReleaseArtifact = {
      kind: "self_mod_blueprint",
      schemaVersion: 1,
      manifest: releaseRecord.manifest,
      applyGuidance: "Use the blueprint as reference.",
      batches: [
        {
          batchId: "batch:published:1",
          ordinal: 1,
          commitHash: "published-commit-1",
          files: ["src/installed.ts"],
          subject: "Install Weather Widget",
          body: "",
          patch: "diff --git a/src/installed.ts b/src/installed.ts",
        },
      ],
      files: [
        {
          path: "src/installed.ts",
          changeType: "create",
          referenceContentBase64: Buffer.from("export const installed = true;\n", "utf8").toString("base64"),
        },
      ],
    };

    const result = await service.installRelease({
      packageId: packageRecord.packageId,
      releaseNumber: releaseRecord.releaseNumber,
      fetchRelease: async () => ({
        package: packageRecord,
        release: releaseRecord,
        artifact,
      }),
      applyRelease: async () => {
        await service.beginSelfModRun({
          runId: "run-install-1",
          taskDescription: "Install Weather Widget",
          featureId: packageRecord.featureId,
          packageId: packageRecord.packageId,
          releaseNumber: releaseRecord.releaseNumber,
          applyMode: "install",
          displayName: packageRecord.displayName,
          description: packageRecord.description,
        });
        writeFile(repoRoot, "src/installed.ts", "export const installed = true;\n");
        await service.finalizeSelfModRun({
          runId: "run-install-1",
          succeeded: true,
        });
      },
    });

    expect(result.installRecord.packageId).toBe("weather-widget");
    expect(result.installRecord.featureId).toBe("weather-widget-store");
    expect(result.installRecord.releaseNumber).toBe(1);
    expect(result.installRecord.applyCommitHashes).toHaveLength(1);
    expect(service.getInstalledModByPackageId("weather-widget")?.state).toBe("installed");
    expect(
      service.listFeatureBatches("weather-widget-store").map((batch) => batch.state),
    ).toEqual(["published"]);

    close();
  });
});
