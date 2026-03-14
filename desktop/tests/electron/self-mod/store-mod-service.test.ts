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
});
