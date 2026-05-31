import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStellaSourceChangeSetFromTrees,
  createStellaSourcePack,
  hashSourceTree,
  type StellaSourceTree,
} from "../../../../runtime/kernel/self-mod/stella-source-control.js";
import { StoreModService } from "../../../../runtime/kernel/self-mod/store-mod-service.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import { StellaSourceHistoryStore } from "../../../../runtime/kernel/storage/stella-source-history-store.js";
import { StoreModStore } from "../../../../runtime/kernel/storage/store-mod-store.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import type { ExternalSourceImportRunner } from "../../../../runtime/worker/source-import-external.js";
import { importExternalSource } from "../../../../runtime/worker/source-import-external.js";
import type { SourceImportLifecycle } from "../../../../runtime/worker/source-import.js";
import { trySourceImportFastPath } from "../../../../runtime/worker/source-import.js";

const execFileAsync = promisify(execFile);
const text = (content: string) => ({ kind: "text" as const, content });

const PANEL_BASE = "export const panel = 'base';\n";
const PACKAGE_BASE = [
  "{",
  '  "name": "stella-validation",',
  '  "private": true,',
  '  "scripts": {',
  '    "dev": "vite"',
  "  }",
  "}",
  "",
].join("\n");

const PACKAGE_WITH_STORE_IMPORT = [
  "{",
  '  "name": "stella-validation",',
  '  "private": true,',
  '  "scripts": {',
  '    "dev": "vite",',
  '    "store-clean": "node desktop/src/panel.ts"',
  "  }",
  "}",
  "",
].join("\n");

type ScenarioInstall = {
  root: string;
  stellaHome: string;
  db: SqliteDatabase;
  store: StoreModStore;
  sourceHistory: StellaSourceHistoryStore;
  service: StoreModService;
  releaseCommit: string;
};

type LifecycleRecorder = {
  beginCalls: Array<{ runId: string; paths: string[] }>;
  finishCalls: Array<{ runId: string; succeeded: boolean }>;
  lifecycle: SourceImportLifecycle;
};

const extraRoots = new Set<string>();
const activeInstalls = new Set<ScenarioInstall>();

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return String(result.stdout ?? "").trim();
};

const configureGitIdentity = async (repoRoot: string): Promise<void> => {
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Stella Test"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
};

const createStoreSourcePack = (args: {
  baseTree: StellaSourceTree;
  nextTree: StellaSourceTree;
}) => {
  const baseRevisionId = hashSourceTree(args.baseTree);
  return createStellaSourcePack({
    baseRevisionId,
    changeSets: [
      createStellaSourceChangeSetFromTrees({
        baseRevisionId,
        baseTree: args.baseTree,
        nextTree: args.nextTree,
      }),
    ],
  });
};

const writeJson = async (
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createLauncherStyleInstall = async (): Promise<ScenarioInstall> => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-launcher-flow-"));
  const repoRoot = path.join(parent, "stella");
  const stellaHome = path.join(repoRoot, "state", "electron-user-data");
  await mkdir(path.join(repoRoot, "desktop", "src"), { recursive: true });
  await mkdir(path.join(repoRoot, "runtime", "worker"), { recursive: true });
  await mkdir(stellaHome, { recursive: true });

  await writeFile(path.join(repoRoot, "desktop", "src", "panel.ts"), PANEL_BASE);
  await writeFile(path.join(repoRoot, "runtime", "worker", "marker.ts"), "export {};\n");
  await writeFile(path.join(repoRoot, "package.json"), PACKAGE_BASE);
  await writeFile(path.join(repoRoot, ".gitignore"), "node_modules/\nstate/\n");
  await writeFile(path.join(repoRoot, "launch.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(path.join(repoRoot, "launch.sh"), 0o755);

  await runGit(repoRoot, ["init"]);
  await configureGitIdentity(repoRoot);
  await runGit(repoRoot, ["remote", "add", "origin", "https://github.com/ruuxi/stella"]);
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-m", "launcher release payload"]);
  const releaseCommit = await runGit(repoRoot, ["rev-parse", "HEAD"]);

  await writeJson(path.join(repoRoot, "stella-release.json"), {
    schemaVersion: 1,
    tag: "desktop-validation-base",
    commit: releaseCommit,
  });
  await writeJson(path.join(repoRoot, "stella-install.json"), {
    version: "0.0.0-validation",
    desktopReleaseTag: "desktop-validation-base",
    desktopReleaseCommit: releaseCommit,
    desktopInstallBaseCommit: releaseCommit,
    platform: process.platform,
    installedAt: "2026-05-31T00:00:00.000Z",
    installPath: repoRoot,
    launchScript: path.join(repoRoot, "launch.sh"),
    shortcuts: {},
  });
  await runGit(repoRoot, ["add", "stella-release.json", "stella-install.json"]);
  await runGit(repoRoot, ["commit", "-m", "launcher install metadata"]);

  const db = new DatabaseSync(getDesktopDatabasePath(stellaHome), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new StoreModStore(db);
  const sourceHistory = new StellaSourceHistoryStore(db);
  const install = {
    root: repoRoot,
    stellaHome,
    db,
    store,
    sourceHistory,
    service: new StoreModService(repoRoot, store, sourceHistory),
    releaseCommit,
  };
  activeInstalls.add(install);
  return install;
};

const createLifecycleRecorder = (): LifecycleRecorder => {
  const beginCalls: LifecycleRecorder["beginCalls"] = [];
  const finishCalls: LifecycleRecorder["finishCalls"] = [];
  return {
    beginCalls,
    finishCalls,
    lifecycle: {
      beginExternalSelfMod: async (args) => {
        beginCalls.push({ runId: args.runId, paths: [...args.paths] });
        return { ok: true };
      },
      finishExternalSelfMod: async (args) => {
        finishCalls.push({ ...args });
        return { ok: true };
      },
    },
  };
};

const cloneSourceRepo = async (
  sourceRepoRoot: string,
  targetRepoRoot: string,
): Promise<void> => {
  await runGit(path.dirname(sourceRepoRoot), [
    "clone",
    targetRepoRoot,
    sourceRepoRoot,
  ]);
  await configureGitIdentity(sourceRepoRoot);
};

afterEach(async () => {
  for (const install of activeInstalls) {
    install.db.close();
    await rm(path.dirname(install.root), { recursive: true, force: true });
  }
  activeInstalls.clear();
  for (const root of extraRoots) {
    await rm(root, { recursive: true, force: true });
  }
  extraRoots.clear();
});

describe("launcher-style source import scenarios", () => {
  it("cleanly installs a Store source pack through real git, SQLite, tracking, and lifecycle hooks", async () => {
    const install = await createLauncherStyleInstall();
    const beforeHead = await runGit(install.root, ["rev-parse", "HEAD"]);
    const sourcePack = createStoreSourcePack({
      baseTree: {
        "desktop/src/panel.ts": text(PANEL_BASE),
        "package.json": text(PACKAGE_BASE),
      },
      nextTree: {
        "desktop/src/panel.ts": text(`${PANEL_BASE}export const cleanStore = true;\n`),
        "package.json": text(PACKAGE_WITH_STORE_IMPORT),
      },
    });
    const lifecycle = createLifecycleRecorder();

    const result = await trySourceImportFastPath({
      repoRoot: install.root,
      service: install.service,
      source: {
        kind: "store-package",
        packageId: "clean-store-package",
        releaseNumber: 7,
        displayName: "Clean Store Package",
        sourcePack,
      },
      scope: { kind: "all" },
      trust: "untrusted",
      applyMode: "install",
      lifecycle: lifecycle.lifecycle,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error(result.reason);
    }
    expect(await runGit(install.root, ["rev-parse", "HEAD"])).not.toBe(
      beforeHead,
    );
    await expect(
      readFile(path.join(install.root, "desktop", "src", "panel.ts"), "utf8"),
    ).resolves.toContain("cleanStore");
    await expect(
      readFile(path.join(install.root, "package.json"), "utf8"),
    ).resolves.toContain("store-clean");

    const installRecord = install.service.getInstall("clean-store-package");
    expect(installRecord).toMatchObject({
      packageId: "clean-store-package",
      releaseNumber: 7,
      installCommitHash: result.installRecord.installCommitHash,
    });
    expect(installRecord?.sourceRevisionIds).toContain(sourcePack.revisionId);

    const sourceRevision = install.sourceHistory.findRevisionByCommit(
      result.installRecord.installCommitHash,
    );
    expect(sourceRevision).toMatchObject({
      origin: "store-install",
      packageId: "clean-store-package",
      releaseNumber: 7,
    });

    expect(lifecycle.beginCalls).toHaveLength(1);
    expect(lifecycle.beginCalls[0]?.paths).toEqual(
      expect.arrayContaining([
        "desktop/src/panel.ts",
        "package.json",
        "bun.lock",
      ]),
    );
    expect(lifecycle.finishCalls).toEqual([
      { runId: lifecycle.beginCalls[0]?.runId, succeeded: true },
    ]);

    const commitMessage = await runGit(install.root, [
      "log",
      "-1",
      "--format=%B",
    ]);
    expect(commitMessage).toContain("Store install: clean-store-package");
    expect(commitMessage).toContain("Stella-Conversation: store-install:clean-store-package");
    expect(commitMessage).toContain("Stella-Package-Id: clean-store-package");
  });

  it("cleanly imports a related git ref without invoking review or agent fallback", async () => {
    const install = await createLauncherStyleInstall();
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "stella-related-source-"));
    extraRoots.add(sourceRoot);
    await cloneSourceRepo(sourceRoot, install.root);
    await writeFile(
      path.join(sourceRoot, "desktop", "src", "panel.ts"),
      `${PANEL_BASE}export const fromGit = true;\n`,
      "utf8",
    );
    await runGit(sourceRoot, ["add", "desktop/src/panel.ts"]);
    await runGit(sourceRoot, ["commit", "-m", "add git import"]);

    const beforeHead = await runGit(install.root, ["rev-parse", "HEAD"]);
    const lifecycle = createLifecycleRecorder();
    const runReview = vi.fn(async () => {
      throw new Error("review should be skipped for trusted source");
    });
    const runBlockingLocalAgent = vi.fn(async () => {
      throw new Error("clean git import should not need the agent");
    });

    const result = await importExternalSource({
      repoRoot: install.root,
      stellaHome: install.stellaHome,
      source: { kind: "git", url: `${sourceRoot}#HEAD` },
      scope: { kind: "all" },
      trust: "trusted",
      conversationId: "conv-clean-git",
      requestId: "req-clean-git",
      service: install.service,
      lifecycle: lifecycle.lifecycle,
      runReview,
      runBlockingLocalAgent,
    });
    extraRoots.add(result.importRoot);

    expect(result).toMatchObject({
      status: "applied",
      fastPath: { attempted: true, applied: true },
      review: { skipped: true, reason: "trusted source" },
    });
    expect(result.commitHash).not.toBe(beforeHead);
    expect(runReview).not.toHaveBeenCalled();
    expect(runBlockingLocalAgent).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(install.root, "desktop", "src", "panel.ts"), "utf8"),
    ).resolves.toContain("fromGit");

    expect(lifecycle.beginCalls).toHaveLength(1);
    expect(lifecycle.beginCalls[0]?.paths).toContain("desktop/src/panel.ts");
    expect(lifecycle.finishCalls).toEqual([
      { runId: lifecycle.beginCalls[0]?.runId, succeeded: true },
    ]);
    expect(
      install.sourceHistory.findRevisionByCommit(result.commitHash)?.origin,
    ).toBe("self-mod");
  });

  it("falls back to a real self-mod commit when native git import is not clean", async () => {
    const install = await createLauncherStyleInstall();
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "stella-conflict-source-"));
    extraRoots.add(sourceRoot);
    await cloneSourceRepo(sourceRoot, install.root);
    await writeFile(
      path.join(sourceRoot, "desktop", "src", "panel.ts"),
      "export const panel = 'source version';\n",
      "utf8",
    );
    await runGit(sourceRoot, ["add", "desktop/src/panel.ts"]);
    await runGit(sourceRoot, ["commit", "-m", "source changes panel"]);

    await writeFile(
      path.join(install.root, "desktop", "src", "panel.ts"),
      "export const panel = 'local version';\n",
      "utf8",
    );
    await runGit(install.root, ["add", "desktop/src/panel.ts"]);
    await runGit(install.root, ["commit", "-m", "local divergence"]);

    const beforeImportHead = await runGit(install.root, ["rev-parse", "HEAD"]);
    let fallbackPrompt = "";
    const runBlockingLocalAgent: ExternalSourceImportRunner = async (request) => {
      fallbackPrompt = request.prompt;
      expect(request.selfModMetadata).toEqual({ mode: "author" });
      expect(request.prompt).toContain("Resolved source root");
      expect(request.prompt).toContain("Automatic import path skipped: Native git merge-tree was not clean");

      const runId = "deterministic-conflict-agent";
      await install.service.beginSelfModRun({
        runId,
        taskDescription: request.description,
        applyMode: "author",
      });
      await writeFile(
        path.join(install.root, "desktop", "src", "panel.ts"),
        [
          "export const panel = 'local version';",
          "export const sourceIntent = 'adapted after conflict';",
          "",
        ].join("\n"),
        "utf8",
      );
      const finalized = await install.service.finalizeSelfModRun({
        runId,
        succeeded: true,
        conversationId: request.conversationId,
        threadKey: "agent-conflict",
        commitMessageProvider: async () => "Adapt conflicted source import",
      });
      expect(finalized?.commitHash).toBeTruthy();
      return {
        status: "ok",
        finalText: "adapted",
        threadId: "agent-conflict",
      };
    };

    const result = await importExternalSource({
      repoRoot: install.root,
      stellaHome: install.stellaHome,
      source: { kind: "git", url: `${sourceRoot}#HEAD` },
      scope: { kind: "all" },
      trust: "trusted",
      conversationId: "conv-conflict-git",
      requestId: "req-conflict-git",
      service: install.service,
      runReview: async () => {
        throw new Error("review should be skipped for trusted source");
      },
      runBlockingLocalAgent,
    });
    extraRoots.add(result.importRoot);

    expect(result).toMatchObject({
      status: "applied-by-agent",
      threadId: "agent-conflict",
      fastPath: {
        attempted: true,
        applied: false,
      },
    });
    expect(result.fastPath.reason).toContain(
      "Native git merge-tree was not clean",
    );
    await expect(
      readFile(path.join(result.importRoot, "RECENT_COMMITS.txt"), "utf8"),
    ).resolves.toContain("source changes panel");
    expect(fallbackPrompt).toContain("RECENT_COMMITS.txt");
    expect(result.commitHash).not.toBe(beforeImportHead);
    await expect(
      readFile(path.join(install.root, "desktop", "src", "panel.ts"), "utf8"),
    ).resolves.toContain("adapted after conflict");
    expect(
      install.sourceHistory.findRevisionByCommit(result.commitHash)?.origin,
    ).toBe("self-mod");
  });

  it("blocks untrusted imports before any agent or git write when review fails", async () => {
    const install = await createLauncherStyleInstall();
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "stella-blocked-source-"));
    extraRoots.add(sourceRoot);
    await writeFile(path.join(sourceRoot, "README.md"), "# blocked\n", "utf8");
    const beforeHead = await runGit(install.root, ["rev-parse", "HEAD"]);
    const runBlockingLocalAgent = vi.fn(async () => {
      throw new Error("blocked review must not invoke agent");
    });

    await expect(
      importExternalSource({
        repoRoot: install.root,
        stellaHome: install.stellaHome,
        source: { kind: "local-path", path: sourceRoot },
        scope: { kind: "all" },
        trust: "untrusted",
        conversationId: "conv-blocked",
        requestId: "req-blocked",
        service: install.service,
        runReview: async () =>
          '{"decision":"block","reason":"credential harvesting"}',
        runBlockingLocalAgent,
      }),
    ).rejects.toThrow(
      "Source import review blocked this source: credential harvesting",
    );

    expect(runBlockingLocalAgent).not.toHaveBeenCalled();
    expect(await runGit(install.root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await runGit(install.root, ["status", "--short"])).toBe("");
    expect(install.sourceHistory.findRevisionByCommit(beforeHead)).toBeNull();
  });
});
