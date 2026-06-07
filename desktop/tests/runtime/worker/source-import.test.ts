import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStellaSourceChangeSetFromTrees,
  createStellaSourcePack,
  hashSourceTree,
  type StellaSourceTree,
} from "../../../../runtime/kernel/self-mod/stella-source-control.js";
import type { StoreModService } from "../../../../runtime/kernel/self-mod/store-mod-service.js";
import {
  importExternalSource,
  prepareExternalSourceImport,
} from "../../../../runtime/worker/source-import-external.js";
import { trySourceImportFastPath } from "../../../../runtime/worker/source-import.js";

const execFileAsync = promisify(execFile);
const text = (content: string) => ({ kind: "text" as const, content });

const runGit = async (cwd: string, args: string[]) => {
  await execFileAsync("git", args, { cwd });
};

const createService = () => {
  const service = {
    beginSelfModRun: vi.fn(async () => undefined),
    finalizeSelfModRun: vi.fn(async () => ({
      commitHash: "f".repeat(40),
      files: ["src/panel.ts"],
      blockedFiles: [],
      sourceRevisionId: "local-source-revision",
    })),
    cancelSelfModRun: vi.fn(),
    recordInstall: vi.fn((args) => ({
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      installCommitHash: args.installCommitHash,
      installCommitHashes: args.installCommitHash
        ? [args.installCommitHash]
        : [],
      sourceRevisionId: args.sourceRevisionId ?? null,
      sourceRevisionIds: [
        ...(args.sourceRevisionIds ?? []),
        ...(args.sourceRevisionId ? [args.sourceRevisionId] : []),
      ],
      installedAt: 123,
    })),
  };
  return service as unknown as StoreModService & typeof service;
};

describe("trySourceImportFastPath", () => {
  let repoRoot = "";
  let extraRoots: string[] = [];

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-source-import-"));
    extraRoots = [];
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Stella Test"]);
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "panel.ts"), "base\n", "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "base"]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    for (const root of extraRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a clean source import and records the install", async () => {
    const baseTree: StellaSourceTree = {
      "src/panel.ts": text("base\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/panel.ts": text("base\nfeature\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const sourcePack = createStellaSourcePack({
      baseRevisionId,
      changeSets: [
        createStellaSourceChangeSetFromTrees({
          baseRevisionId,
          baseTree,
          nextTree,
        }),
      ],
    });
    const service = createService();

    const result = await trySourceImportFastPath({
      repoRoot,
      service,
      source: {
        kind: "store-package",
        packageId: "quiet-mode",
        releaseNumber: 1,
        displayName: "Quiet Mode",
        sourcePack,
      },
      scope: { kind: "all" },
      trust: "untrusted",
      applyMode: "install",
    });

    expect(result.status).toBe("applied");
    await expect(
      readFile(path.join(repoRoot, "src", "panel.ts"), "utf8"),
    ).resolves.toBe("base\nfeature\n");
    expect(service.beginSelfModRun).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: "quiet-mode",
        releaseNumber: 1,
        applyMode: "install",
      }),
    );
    expect(service.recordInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: "quiet-mode",
        releaseNumber: 1,
        installCommitHash: "f".repeat(40),
        sourceRevisionIds: [sourcePack.revisionId],
      }),
    );
  });

  it("falls back to the agent when the working tree is dirty", async () => {
    await writeFile(path.join(repoRoot, "local.txt"), "dirty\n", "utf8");
    const baseTree: StellaSourceTree = {
      "src/panel.ts": text("base\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/panel.ts": text("next\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const service = createService();

    const result = await trySourceImportFastPath({
      repoRoot,
      service,
      source: {
        kind: "store-package",
        packageId: "quiet-mode",
        releaseNumber: 1,
        displayName: "Quiet Mode",
        sourcePack: createStellaSourcePack({
          baseRevisionId,
          changeSets: [
            createStellaSourceChangeSetFromTrees({
              baseRevisionId,
              baseTree,
              nextTree,
            }),
          ],
        }),
      },
      scope: { kind: "all" },
      trust: "untrusted",
      applyMode: "install",
    });

    expect(result).toMatchObject({
      status: "needs-agent",
      reason: "The install tree has local working-tree changes.",
    });
    expect(service.beginSelfModRun).not.toHaveBeenCalled();
  });

  it("prepares a local source import with materialized summary files", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-source-"),
    );
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-home-"),
    );
    extraRoots.push(sourceRoot);
    extraRoots.push(stellaDataDir);
    await writeFile(path.join(sourceRoot, "README.md"), "# Tool\n", "utf8");
    await writeFile(
      path.join(sourceRoot, "package.json"),
      '{"name":"tool"}\n',
      "utf8",
    );

    const prepared = await prepareExternalSourceImport({
      repoRoot,
      stellaDataDir,
      source: { kind: "local-path", path: sourceRoot },
      scope: { kind: "feature", label: "command palette" },
      trust: "untrusted",
    });

    await expect(readFile(prepared.summaryPath, "utf8")).resolves.toContain(
      "Scope: feature: command palette",
    );
    await expect(readFile(prepared.treePath, "utf8")).resolves.toContain(
      "README.md",
    );
    expect(prepared.git).toBeUndefined();
  });

  it("keeps source import materials outside the target repo", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-source-"),
    );
    extraRoots.push(sourceRoot);
    await writeFile(path.join(sourceRoot, "README.md"), "# Tool\n", "utf8");

    const prepared = await prepareExternalSourceImport({
      repoRoot,
      stellaDataDir: repoRoot,
      source: { kind: "local-path", path: sourceRoot },
      scope: { kind: "all" },
      trust: "trusted",
    });
    extraRoots.push(prepared.importRoot);

    expect(path.relative(repoRoot, prepared.importRoot).startsWith("..")).toBe(
      true,
    );
    await expect(readFile(prepared.summaryPath, "utf8")).resolves.toContain(
      "Source:",
    );
  });

  it("imports a related local git source through the native git fast path", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-related-"),
    );
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-home-"),
    );
    extraRoots.push(sourceRoot);
    extraRoots.push(stellaDataDir);
    await runGit(path.dirname(sourceRoot), ["clone", repoRoot, sourceRoot]);
    await runGit(sourceRoot, ["config", "user.email", "test@example.com"]);
    await runGit(sourceRoot, ["config", "user.name", "Stella Test"]);
    await writeFile(
      path.join(sourceRoot, "src", "panel.ts"),
      "base\nfrom source\n",
      "utf8",
    );
    await runGit(sourceRoot, ["add", "."]);
    await runGit(sourceRoot, ["commit", "-m", "add source feature"]);

    const service = createService();
    const runBlockingLocalAgent = vi.fn(async () => ({
      status: "ok" as const,
      finalText: "",
      threadId: "agent-1",
    }));
    const runReview = vi.fn(async () => {
      throw new Error("review should be skipped for trusted source");
    });

    const result = await importExternalSource({
      repoRoot,
      stellaDataDir,
      source: { kind: "git", url: `${sourceRoot}#HEAD` },
      scope: { kind: "all" },
      trust: "trusted",
      conversationId: "conv-1",
      requestId: "req-1",
      service,
      runReview,
      runBlockingLocalAgent,
    });

    expect(result).toMatchObject({
      status: "applied",
      commitHash: "f".repeat(40),
      fastPath: { attempted: true, applied: true },
    });
    await expect(
      readFile(path.join(repoRoot, "src", "panel.ts"), "utf8"),
    ).resolves.toBe("base\nfrom source\n");
    expect(runReview).not.toHaveBeenCalled();
    expect(runBlockingLocalAgent).not.toHaveBeenCalled();
    expect(service.beginSelfModRun).toHaveBeenCalledWith(
      expect.objectContaining({
        applyMode: "author",
      }),
    );
  });

  it("blocks untrusted external imports when the review fails", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-blocked-"),
    );
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-import-home-"),
    );
    extraRoots.push(sourceRoot);
    extraRoots.push(stellaDataDir);
    await writeFile(path.join(sourceRoot, "README.md"), "# Bad\n", "utf8");
    const service = createService();
    const runBlockingLocalAgent = vi.fn(async () => ({
      status: "ok" as const,
      finalText: "",
      threadId: "agent-1",
    }));

    await expect(
      importExternalSource({
        repoRoot,
        stellaDataDir,
        source: { kind: "local-path", path: sourceRoot },
        scope: { kind: "all" },
        trust: "untrusted",
        conversationId: "conv-1",
        requestId: "req-1",
        service,
        runReview: async () =>
          '{"decision":"block","reason":"credential harvesting"}',
        runBlockingLocalAgent,
      }),
    ).rejects.toThrow(
      "Source import review blocked this source: credential harvesting",
    );
    expect(runBlockingLocalAgent).not.toHaveBeenCalled();
  });
});
