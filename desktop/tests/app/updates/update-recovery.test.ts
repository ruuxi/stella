import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeHelperPlatformKey,
  recordAppliedDesktopUpdate,
  reconcileUpdaterOwnedPaths,
  recoverInterruptedDesktopUpdate,
  stageStellaBrowserUpdate,
  tryApplyCleanDesktopUpdate,
  verifyMergeApplied,
} from "../../../electron/ipc/updates-handlers.js";

describe("desktop release artifact platform selection", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["win32", "x64", "win-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["linux", "x64", "linux-x64"],
  ] as const)("maps %s-%s to %s", (platform, arch, expected) => {
    expect(nativeHelperPlatformKey(platform, arch)).toBe(expected);
  });
});

const git = (
  cwd: string,
  args: string[],
  options?: { allowFailure?: boolean },
) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!options?.allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

const addOriginAtTarget = (repoRoot: string, targetCommit: string) => {
  git(repoRoot, ["branch", "-f", "master", targetCommit]);
  git(repoRoot, ["remote", "add", "origin", repoRoot]);
};

const platformKey =
  process.platform === "win32" && process.arch === "x64"
    ? "win-x64"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : "linux-x64";

const writeInstallManifest = async (
  repoRoot: string,
  args: {
    activeCommit: string;
    attempt: Record<string, unknown> | null;
  },
) => {
  await writeFile(
    path.join(repoRoot, "stella-install.json"),
    `${JSON.stringify(
      {
        version: "test",
        platform: process.platform,
        installPath: repoRoot,
        installedAt: new Date(0).toISOString(),
        desktopReleaseTag: null,
        desktopReleaseCommit: args.activeCommit,
        installState: {
          status: "complete",
          desktopReleaseTag: null,
          desktopReleaseCommit: args.activeCommit,
          localHeadCommit: args.activeCommit,
          nativeHelpersSha: null,
          completedAt: new Date(0).toISOString(),
        },
        lastUpdateAttempt: args.attempt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const readInstallManifest = async (repoRoot: string) =>
  JSON.parse(
    await readFile(path.join(repoRoot, "stella-install.json"), "utf8"),
  );

const writeNativeHelperDownloadStub = async (repoRoot: string) => {
  const scriptPath = path.join(
    repoRoot,
    "desktop",
    "scripts",
    "download-native-helpers.mjs",
  );
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    "process.stdout.write('native helpers already current\\n');\n",
    "utf8",
  );
};

describe("stageStellaBrowserUpdate", () => {
  it("downloads and stages the pinned platform binary without replacing the running one", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stella-browser-update-"),
    );
    const binaryName =
      platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
    const binaryPath = path.join(
      root,
      "desktop",
      "stella-browser",
      "out",
      platformKey,
      binaryName,
    );
    const oldBytes = Buffer.from("old-browser-binary");
    const nextBytes = Buffer.from("new-browser-binary");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, oldBytes);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(nextBytes, { status: 200 }));

    try {
      const relativePath = await stageStellaBrowserUpdate(root, [
        {
          kind: "stella-browser",
          platform: platformKey,
          asset: {
            url: "https://releases.test/stella-browser",
            sha256: `sha256:${createHash("sha256").update(nextBytes).digest("hex")}`,
            sizeBytes: nextBytes.byteLength,
          },
        },
      ]);

      expect(relativePath).toBe(
        `desktop/stella-browser/out/${platformKey}/${binaryName}`,
      );
      expect(await readFile(binaryPath)).toEqual(oldBytes);
      expect(await readFile(`${binaryPath}.update`)).toEqual(nextBytes);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not download an artifact that is already installed", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stella-browser-current-"),
    );
    const binaryName =
      platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
    const binaryPath = path.join(
      root,
      "desktop",
      "stella-browser",
      "out",
      platformKey,
      binaryName,
    );
    const bytes = Buffer.from("current-browser-binary");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, bytes);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await expect(
        stageStellaBrowserUpdate(root, [
          {
            kind: "stella-browser",
            platform: platformKey,
            asset: {
              url: "https://releases.test/stella-browser",
              sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
              sizeBytes: bytes.byteLength,
            },
          },
        ]),
      ).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(readFile(`${binaryPath}.update`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      fetchSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("recoverInterruptedDesktopUpdate", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-update-recovery-"));
    git(repoRoot, ["init", "-q", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "test@stella.local"]);
    git(repoRoot, ["config", "user.name", "Stella Test"]);
    git(repoRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8");
    git(repoRoot, ["add", "app.txt"]);
    git(repoRoot, ["commit", "-q", "-m", "Base desktop release"]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("refuses completion while an updater-owned tracked path differs from HEAD", async () => {
    await writeFile(
      path.join(repoRoot, "app.txt"),
      "updater left this dirty\n",
    );
    await expect(
      reconcileUpdaterOwnedPaths(repoRoot, ["app.txt"]),
    ).rejects.toThrow("Updater-owned tracked paths do not match HEAD: app.txt");
  });

  it("completes an already-landed Git update and removes owned native temp files", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, "app.txt"), "target\n", "utf8");
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(
      path.join(repoRoot, ".stella-native-helpers-download.tar.zst"),
      "partial",
      "utf8",
    );
    await mkdir(
      path.join(repoRoot, `.stella-native-helpers-extract-${platformKey}-123`),
      { recursive: true },
    );
    await mkdir(
      path.join(repoRoot, `.stella-native-helpers-files-${platformKey}-123`),
      { recursive: true },
    );

    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: {
        status: "updating",
        targetTag: null,
        targetCommit,
        startedAt: new Date(1).toISOString(),
        finishedAt: null,
        reason: null,
        operationId: "op-git",
        phase: "native-refresh",
        mode: "git",
        recoveryAction: "resume",
        startingHeadCommit: baseCommit,
        updatedAt: new Date(1).toISOString(),
        changedFiles: ["app.txt"],
        ownedTempPaths: [
          ".stella-native-helpers-download.tar.zst",
          `.stella-native-helpers-extract-${platformKey}-*`,
          `.stella-native-helpers-files-${platformKey}-*`,
        ],
        nativeHelpersManifestUrl: "https://helpers.test/current.json",
      },
    });
    const refreshNativeHelpers = vi.fn(async () => undefined);

    const result = await recoverInterruptedDesktopUpdate(repoRoot, {
      refreshNativeHelpers,
    });

    expect(result.status).toBe("completed");
    expect(refreshNativeHelpers).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestUrl: "https://helpers.test/current.json",
      }),
    );
    await expect(
      readFile(path.join(repoRoot, ".stella-native-helpers-download.tar.zst")),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(
          repoRoot,
          `.stella-native-helpers-extract-${platformKey}-123`,
          "anything",
        ),
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(
          repoRoot,
          `.stella-native-helpers-files-${platformKey}-123`,
          "anything",
        ),
      ),
    ).rejects.toThrow();
    const manifest = await readInstallManifest(repoRoot);
    expect(manifest.installState.desktopReleaseCommit).toBe(targetCommit);
    expect(manifest.lastUpdateAttempt).toMatchObject({
      status: "complete",
      phase: "record-complete",
      operationId: "op-git",
    });
  });

  it("finishes a legacy staged-browser index/worktree gap during recovery", async () => {
    const browserName =
      platformKey === "win-x64"
        ? "stella-browser-win32-x64.exe"
        : `stella-browser-${platformKey}`;
    const browserRelativePath = `desktop/stella-browser/bin/${browserName}`;
    const browserPath = path.join(repoRoot, ...browserRelativePath.split("/"));
    await mkdir(path.dirname(browserPath), { recursive: true });
    await writeFile(browserPath, "old-browser", { mode: 0o755 });
    git(repoRoot, ["add", browserRelativePath]);
    git(repoRoot, ["commit", "-m", "Track legacy browser binary"]);
    const startingHeadCommit = git(repoRoot, [
      "rev-parse",
      "HEAD",
    ]).stdout.trim();

    await writeFile(`${browserPath}.update`, "new-browser", { mode: 0o755 });
    const objectId = git(repoRoot, [
      "hash-object",
      "-w",
      `${browserRelativePath}.update`,
    ]).stdout.trim();
    git(repoRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `100755,${objectId},${browserRelativePath}`,
    ]);
    git(repoRoot, ["commit", "-m", "Update to desktop-v9.9.12"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    expect(await readFile(browserPath, "utf8")).toBe("old-browser");
    expect(
      git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).stdout,
    ).toContain(browserRelativePath);

    await writeInstallManifest(repoRoot, {
      activeCommit: startingHeadCommit,
      attempt: {
        status: "updating",
        targetTag: "desktop-v9.9.12",
        targetCommit,
        startedAt: new Date(1).toISOString(),
        finishedAt: null,
        reason: null,
        operationId: "op-browser-gap",
        phase: "native-refresh",
        mode: "git",
        recoveryAction: "resume",
        startingHeadCommit,
        updatedAt: new Date(1).toISOString(),
        changedFiles: [browserRelativePath],
        ownedTempPaths: [],
        nativeHelpersManifestUrl: null,
      },
    });

    const result = await recoverInterruptedDesktopUpdate(repoRoot, {
      refreshNativeHelpers: vi.fn(async () => undefined),
    });

    expect(result.status).toBe("completed");
    expect(await readFile(browserPath, "utf8")).toBe("new-browser");
    await expect(readFile(`${browserPath}.update`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).stdout,
    ).toBe("");
  });

  it("does not auto-abort a merge-in-progress from an interrupted update", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, ".git", "MERGE_HEAD"), "f".repeat(40));
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: {
        status: "updating",
        targetTag: "desktop-v9.9.9",
        targetCommit: "f".repeat(40),
        startedAt: new Date(1).toISOString(),
        finishedAt: null,
        reason: null,
        operationId: "op-merge",
        phase: "git-merge",
        mode: "git",
        recoveryAction: "resume",
        startingHeadCommit: baseCommit,
        updatedAt: new Date(1).toISOString(),
        changedFiles: ["app.txt"],
        ownedTempPaths: [],
        nativeHelpersManifestUrl: null,
      },
    });

    const result = await recoverInterruptedDesktopUpdate(repoRoot, {
      refreshNativeHelpers: vi.fn(async () => undefined),
    });

    expect(result.status).toBe("needs-agent");
    await expect(
      readFile(path.join(repoRoot, ".git", "MERGE_HEAD"), "utf8"),
    ).resolves.toBe("f".repeat(40));
    expect(
      (await readInstallManifest(repoRoot)).lastUpdateAttempt,
    ).toMatchObject({
      status: "failed",
      recoveryAction: "needs-agent",
    });
  });

  it("morphs a conflict-recovered agent update before recording completion", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["checkout", "-q", "-b", "upstream"]);
    await writeFile(
      path.join(repoRoot, "app.txt"),
      "upstream target\n",
      "utf8",
    );
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

    git(repoRoot, ["checkout", "-q", "main"]);
    await writeFile(
      path.join(repoRoot, "app.txt"),
      "local customization\n",
      "utf8",
    );
    git(repoRoot, ["commit", "-am", "Customize desktop"]);
    const startingHeadCommit = git(repoRoot, [
      "rev-parse",
      "HEAD",
    ]).stdout.trim();
    expect(
      git(repoRoot, ["merge", "--no-edit", targetCommit], {
        allowFailure: true,
      }).status,
    ).not.toBe(0);
    await writeFile(
      path.join(repoRoot, "app.txt"),
      "resolved customization plus update\n",
      "utf8",
    );
    git(repoRoot, ["add", "app.txt"]);
    git(repoRoot, ["commit", "-q", "--no-edit"]);
    expect(
      git(repoRoot, ["rev-list", "--parents", "-n", "1", "HEAD"])
        .stdout.trim()
        .split(/\s+/),
    ).toHaveLength(3);

    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: {
        status: "failed",
        targetTag: "desktop-v9.9.10",
        targetCommit,
        startedAt: new Date(1).toISOString(),
        finishedAt: new Date(2).toISOString(),
        reason: "Stella could not confirm the update was applied.",
        operationId: "op-agent-recovery",
        phase: "native-refresh",
        mode: "agent",
        recoveryAction: "needs-agent",
        startingHeadCommit,
        updatedAt: new Date(2).toISOString(),
        changedFiles: ["app.txt"],
        ownedTempPaths: [],
        nativeHelpersManifestUrl: null,
      },
    });

    const runner = {
      beginExternalSelfMod: vi.fn(async (payload: { paths: string[] }) => {
        expect(payload.paths).toContain("app.txt");
      }),
      finishExternalSelfMod: vi.fn(
        async (payload: { runId: string; succeeded: boolean }) => {
          expect(payload.succeeded).toBe(true);
          if (payload.runId === "install-update-recovery") {
            return { ok: true as const, transitioned: false };
          }
          // The recovered code must be made live before bookkeeping advances.
          await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
            installState: { desktopReleaseCommit: baseCommit },
            lastUpdateAttempt: { status: "failed" },
          });
          return { ok: true as const, transitioned: true };
        },
      ),
    } as unknown as Parameters<typeof recordAppliedDesktopUpdate>[0]["runner"];

    const manifest = await recordAppliedDesktopUpdate({
      stellaAppDir: repoRoot,
      runner,
      commit: targetCommit,
      tag: "desktop-v9.9.10",
      agentRunId: "install-update-recovery",
    });

    expect(runner?.beginExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(runner?.finishExternalSelfMod).toHaveBeenCalledTimes(2);
    expect(manifest).toMatchObject({
      installState: { desktopReleaseCommit: targetCommit },
      lastUpdateAttempt: {
        status: "complete",
        phase: "record-complete",
        targetCommit,
      },
    });
  });

  it("does not double-morph an ordinary successful agent update", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, "app.txt"), "agent target\n", "utf8");
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: {
        status: "updating",
        targetTag: "desktop-v9.9.11",
        targetCommit,
        startedAt: new Date(1).toISOString(),
        finishedAt: null,
        reason: null,
        operationId: "op-agent-normal",
        phase: "native-refresh",
        mode: "agent",
        recoveryAction: "needs-agent",
        startingHeadCommit: baseCommit,
        updatedAt: new Date(1).toISOString(),
        changedFiles: ["app.txt"],
        ownedTempPaths: [],
        nativeHelpersManifestUrl: null,
      },
    });
    const runner = {
      beginExternalSelfMod: vi.fn(async () => undefined),
      finishExternalSelfMod: vi.fn(async () => ({
        ok: true as const,
        transitioned: true,
      })),
    } as unknown as Parameters<typeof recordAppliedDesktopUpdate>[0]["runner"];

    await recordAppliedDesktopUpdate({
      stellaAppDir: repoRoot,
      runner,
      commit: targetCommit,
      tag: "desktop-v9.9.11",
      agentRunId: "install-update-normal",
    });

    expect(runner?.beginExternalSelfMod).not.toHaveBeenCalled();
    expect(runner?.finishExternalSelfMod).toHaveBeenCalledOnce();
    expect(runner?.finishExternalSelfMod).toHaveBeenCalledWith({
      runId: "install-update-normal",
      succeeded: true,
    });
    await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
      installState: { desktopReleaseCommit: targetCommit },
      lastUpdateAttempt: { status: "complete", targetCommit },
    });
  });

  it("brackets a clean Git update in the external self-mod morph lifecycle", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeNativeHelperDownloadStub(repoRoot);
    await writeFile(path.join(repoRoot, "app.txt"), "git target\n", "utf8");
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["reset", "--hard", baseCommit]);
    addOriginAtTarget(repoRoot, targetCommit);

    const events: string[] = [];
    const runner = {
      beginExternalSelfMod: vi.fn(async (payload: { paths: string[] }) => {
        events.push(
          `begin:${await readFile(path.join(repoRoot, "app.txt"), "utf8")}`,
        );
        expect(payload.paths).toContain("app.txt");
      }),
      finishExternalSelfMod: vi.fn(async (payload: { succeeded: boolean }) => {
        events.push(
          `finish:${await readFile(path.join(repoRoot, "app.txt"), "utf8")}`,
        );
        expect(payload.succeeded).toBe(true);
        // The reload morph runs BEFORE completion is recorded, so at finish
        // time the manifest must still point at the base commit — "complete"
        // means the running app actually reloaded.
        await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
          installState: { desktopReleaseCommit: baseCommit },
        });
      }),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(
      repoRoot,
      repoRoot,
      runner,
      {
        baseCommit,
        targetCommit,
        releaseTag: "desktop-v9.9.8",
      },
    );

    expect(result.status).toBe("applied");
    expect(result.status === "applied" && result.reloaded).toBe(true);
    expect(runner?.beginExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(runner?.finishExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["begin:base\n", "finish:git target\n"]);
    expect(git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
      targetCommit,
    );
    expect(git(repoRoot, ["rev-parse", "origin/master"]).stdout.trim()).toBe(
      targetCommit,
    );
    await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
      installState: { desktopReleaseCommit: targetCommit },
      lastUpdateAttempt: {
        status: "complete",
        targetCommit,
      },
    });
  });

  it("rejects a published commit that is not origin/master", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, "app.txt"), "git target\n", "utf8");
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const remoteMaster = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["reset", "--hard", baseCommit]);
    addOriginAtTarget(repoRoot, remoteMaster);
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });

    await expect(
      tryApplyCleanDesktopUpdate(repoRoot, repoRoot, null, {
        baseCommit,
        targetCommit: baseCommit,
        releaseTag: "desktop-v9.9.80",
      }),
    ).rejects.toThrow("did not match origin/master");
    expect(git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim()).toBe(baseCommit);
  });

  it("activates the release browser artifact during a clean Git update", async () => {
    const browserBinaryName =
      platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
    const browserRelativePath = `desktop/stella-browser/out/${platformKey}/${browserBinaryName}`;
    const browserPath = path.join(repoRoot, ...browserRelativePath.split("/"));
    const nextBrowserBytes = Buffer.from("git-update-browser-binary");
    await mkdir(path.dirname(browserPath), { recursive: true });
    await writeFile(browserPath, "old-browser-binary", { mode: 0o755 });
    await writeFile(
      path.join(repoRoot, ".gitignore"),
      "desktop/stella-browser/out/\n",
      "utf8",
    );
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-m", "Ignore hydrated browser artifacts"]);
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeNativeHelperDownloadStub(repoRoot);
    await writeFile(path.join(repoRoot, "app.txt"), "git target\n", "utf8");
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["reset", "--hard", baseCommit]);
    addOriginAtTarget(repoRoot, targetCommit);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(nextBrowserBytes, { status: 200 })),
    );
    const runner = {
      beginExternalSelfMod: vi.fn(async (payload: { paths: string[] }) => {
        expect(payload.paths).toContain("app.txt");
        expect(payload.paths).toContain(browserRelativePath);
      }),
      finishExternalSelfMod: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(
      repoRoot,
      repoRoot,
      runner,
      {
        baseCommit,
        targetCommit,
        releaseTag: "desktop-v9.9.81",
        artifactRefs: [
          {
            kind: "stella-browser",
            platform: platformKey,
            asset: {
              url: "https://releases.test/stella-browser",
              sha256: `sha256:${createHash("sha256").update(nextBrowserBytes).digest("hex")}`,
              sizeBytes: nextBrowserBytes.byteLength,
            },
          },
        ],
      },
    );

    expect(result.status).toBe("applied");
    expect(await readFile(browserPath)).toEqual(nextBrowserBytes);
    await expect(readFile(`${browserPath}.update`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("activates the release browser artifact when resuming an already-landed Git update", async () => {
    const browserBinaryName =
      platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
    const browserRelativePath = `desktop/stella-browser/out/${platformKey}/${browserBinaryName}`;
    const browserPath = path.join(repoRoot, ...browserRelativePath.split("/"));
    const nextBrowserBytes = Buffer.from("resumed-git-browser-binary");
    await mkdir(path.dirname(browserPath), { recursive: true });
    await writeFile(browserPath, "old-browser-binary", { mode: 0o755 });
    await writeFile(
      path.join(repoRoot, ".gitignore"),
      "desktop/stella-browser/out/\n",
      "utf8",
    );
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-m", "Ignore hydrated browser artifacts"]);
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD~1"]).stdout.trim();
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeNativeHelperDownloadStub(repoRoot);
    addOriginAtTarget(repoRoot, targetCommit);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(nextBrowserBytes, { status: 200 })),
    );
    const runner = {
      beginExternalSelfMod: vi.fn(async (payload: { paths: string[] }) => {
        expect(payload.paths).toContain(browserRelativePath);
      }),
      finishExternalSelfMod: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(
      repoRoot,
      repoRoot,
      runner,
      {
        baseCommit,
        targetCommit,
        releaseTag: "desktop-v9.9.82",
        artifactRefs: [
          {
            kind: "stella-browser",
            platform: platformKey,
            asset: {
              url: "https://releases.test/stella-browser",
              sha256: `sha256:${createHash("sha256").update(nextBrowserBytes).digest("hex")}`,
              sizeBytes: nextBrowserBytes.byteLength,
            },
          },
        ],
      },
    );

    expect(result.status).toBe("applied");
    expect(result.status === "applied" && result.reloaded).toBe(true);
    expect(await readFile(browserPath)).toEqual(nextBrowserBytes);
    await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
      installState: { desktopReleaseCommit: targetCommit },
    });
  });

  it("merges a non-conflicting local commit with origin/master", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["checkout", "-q", "-b", "published"]);
    await writeFile(path.join(repoRoot, "app.txt"), "published target\n");
    git(repoRoot, ["commit", "-am", "Published target release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

    git(repoRoot, ["checkout", "-q", "main"]);
    await writeFile(path.join(repoRoot, "local.txt"), "local customization\n");
    git(repoRoot, ["add", "local.txt"]);
    git(repoRoot, ["commit", "-m", "Keep local customization"]);
    addOriginAtTarget(repoRoot, targetCommit);
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeNativeHelperDownloadStub(repoRoot);
    const runner = {
      beginExternalSelfMod: vi.fn(async () => undefined),
      finishExternalSelfMod: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(
      repoRoot,
      repoRoot,
      runner,
      {
        baseCommit,
        targetCommit,
        releaseTag: "desktop-v9.9.85",
      },
    );

    expect(result.status).toBe("applied");
    expect(await readFile(path.join(repoRoot, "app.txt"), "utf8")).toBe(
      "published target\n",
    );
    expect(await readFile(path.join(repoRoot, "local.txt"), "utf8")).toBe(
      "local customization\n",
    );
    expect(
      git(repoRoot, ["merge-base", "--is-ancestor", targetCommit, "HEAD"])
        .status,
    ).toBe(0);
    expect(
      git(repoRoot, ["rev-list", "--parents", "-n", "1", "HEAD"])
        .stdout.trim()
        .split(/\s+/),
    ).toHaveLength(3);
  });

  it("routes a real Git content conflict to the update agent", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["checkout", "-q", "-b", "published"]);
    await writeFile(path.join(repoRoot, "app.txt"), "published target\n");
    git(repoRoot, ["commit", "-am", "Published target release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

    git(repoRoot, ["checkout", "-q", "main"]);
    await writeFile(path.join(repoRoot, "app.txt"), "local customization\n");
    git(repoRoot, ["commit", "-am", "Keep local customization"]);
    const localHead = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    addOriginAtTarget(repoRoot, targetCommit);
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });

    const result = await tryApplyCleanDesktopUpdate(repoRoot, repoRoot, null, {
      baseCommit,
      targetCommit,
      releaseTag: "desktop-v9.9.86",
    });

    expect(result).toMatchObject({
      status: "needs-agent",
      reason: "Git reported merge conflicts.",
      changedFiles: ["app.txt"],
    });
    expect(git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim()).toBe(localHead);
    expect(
      git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        allowFailure: true,
      }).status,
    ).not.toBe(0);
  });

  it("discards a staged browser artifact when a fast-forward is deferred", async () => {
    const browserBinaryName =
      platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
    const browserRelativePath = `desktop/stella-browser/out/${platformKey}/${browserBinaryName}`;
    const browserPath = path.join(repoRoot, ...browserRelativePath.split("/"));
    const nextBrowserBytes = Buffer.from("deferred-browser-binary");
    await mkdir(path.dirname(browserPath), { recursive: true });
    await writeFile(browserPath, "old-browser-binary", { mode: 0o755 });
    await writeFile(
      path.join(repoRoot, ".gitignore"),
      "desktop/stella-browser/out/\n",
      "utf8",
    );
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-m", "Ignore hydrated browser artifacts"]);
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeFile(path.join(repoRoot, "app.txt"), "git target\n", "utf8");
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["reset", "--hard", baseCommit]);
    addOriginAtTarget(repoRoot, targetCommit);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(nextBrowserBytes, { status: 200 })),
    );

    const result = await tryApplyCleanDesktopUpdate(repoRoot, repoRoot, null, {
      baseCommit,
      targetCommit,
      releaseTag: "desktop-v9.9.83",
      artifactRefs: [
        {
          kind: "stella-browser",
          platform: platformKey,
          asset: {
            url: "https://releases.test/stella-browser",
            sha256: `sha256:${createHash("sha256").update(nextBrowserBytes).digest("hex")}`,
            sizeBytes: nextBrowserBytes.byteLength,
          },
        },
      ],
    });

    expect(result.status).toBe("needs-agent");
    expect(await readFile(browserPath, "utf8")).toBe("old-browser-binary");
    await expect(readFile(`${browserPath}.update`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("discards a staged browser artifact when a Git merge fails after preflight", async () => {
    const browserBinaryName =
      platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
    const browserRelativePath = `desktop/stella-browser/out/${platformKey}/${browserBinaryName}`;
    const browserPath = path.join(repoRoot, ...browserRelativePath.split("/"));
    const nextBrowserBytes = Buffer.from("failed-merge-browser-binary");
    await mkdir(path.dirname(browserPath), { recursive: true });
    await writeFile(browserPath, "old-browser-binary", { mode: 0o755 });
    await writeFile(
      path.join(repoRoot, ".gitignore"),
      "desktop/stella-browser/out/\n",
      "utf8",
    );
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-m", "Ignore hydrated browser artifacts"]);
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["checkout", "-q", "-b", "upstream"]);
    await writeFile(
      path.join(repoRoot, "app.txt"),
      "upstream target\n",
      "utf8",
    );
    git(repoRoot, ["commit", "-am", "Target desktop release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["checkout", "-q", "main"]);
    await writeFile(
      path.join(repoRoot, "local.txt"),
      "local overlay\n",
      "utf8",
    );
    git(repoRoot, ["add", "local.txt"]);
    git(repoRoot, ["commit", "-m", "Keep local overlay"]);
    addOriginAtTarget(repoRoot, targetCommit);
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(nextBrowserBytes, { status: 200 })),
    );
    const runner = {
      beginExternalSelfMod: vi.fn(async () => {
        await writeFile(
          path.join(repoRoot, "app.txt"),
          "late conflicting write\n",
          "utf8",
        );
      }),
      finishExternalSelfMod: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(
      repoRoot,
      repoRoot,
      runner,
      {
        baseCommit,
        targetCommit,
        releaseTag: "desktop-v9.9.84",
        artifactRefs: [
          {
            kind: "stella-browser",
            platform: platformKey,
            asset: {
              url: "https://releases.test/stella-browser",
              sha256: `sha256:${createHash("sha256").update(nextBrowserBytes).digest("hex")}`,
              sizeBytes: nextBrowserBytes.byteLength,
            },
          },
        ],
      },
    );

    expect(result.status).toBe("needs-agent");
    expect(await readFile(browserPath, "utf8")).toBe("old-browser-binary");
    await expect(readFile(`${browserPath}.update`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("moves ignored target obstructions aside before a fast-forward", async () => {
    await writeFile(path.join(repoRoot, ".gitignore"), "runtime-cache/\n");
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-m", "Ignore runtime cache"]);
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await mkdir(path.join(repoRoot, "runtime-cache"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "runtime-cache", "config.json"),
      "published target\n",
    );
    git(repoRoot, ["add", "-f", "runtime-cache/config.json"]);
    git(repoRoot, ["commit", "-m", "Publish formerly ignored path"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["reset", "--hard", baseCommit]);
    await mkdir(path.join(repoRoot, "runtime-cache"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "runtime-cache", "config.json"),
      "user runtime data\n",
    );
    addOriginAtTarget(repoRoot, targetCommit);
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeNativeHelperDownloadStub(repoRoot);
    const runner = {
      beginExternalSelfMod: vi.fn(async () => undefined),
      finishExternalSelfMod: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(
      repoRoot,
      repoRoot,
      runner,
      {
        baseCommit,
        targetCommit,
        releaseTag: "desktop-v9.9.19",
      },
    );

    expect(result.status).toBe("applied");
    await expect(
      readFile(path.join(repoRoot, "runtime-cache", "config.json"), "utf8"),
    ).resolves.toBe("published target\n");
    const recoveryBase = path.join(repoRoot, "raw", "desktop-update-recovery");
    const recoveryIds = await readdir(recoveryBase);
    expect(recoveryIds).toHaveLength(1);
    const snapshot = JSON.parse(
      await readFile(
        path.join(recoveryBase, recoveryIds[0]!, "snapshot.json"),
        "utf8",
      ),
    ) as {
      recoveryRef: string;
      movedObstructions: Array<{ path: string; backupPath: string }>;
    };
    expect(snapshot.recoveryRef).toMatch(/^refs\/stella\/update-recovery\//);
    expect(
      git(repoRoot, ["show-ref", "--verify", snapshot.recoveryRef]).status,
    ).toBe(0);
    const moved = snapshot.movedObstructions.find((entry) =>
      entry.path.startsWith("runtime-cache"),
    );
    expect(moved).toBeDefined();
    const movedUserFile = moved!.path.endsWith("/")
      ? path.join(moved!.backupPath, "config.json")
      : moved!.backupPath;
    await expect(readFile(movedUserFile, "utf8")).resolves.toBe(
      "user runtime data\n",
    );
  });
});

describe("verifyMergeApplied", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-verify-merge-"));
    git(repoRoot, ["init", "-q", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "test@stella.local"]);
    git(repoRoot, ["config", "user.name", "Stella Test"]);
    git(repoRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8");
    git(repoRoot, ["add", "app.txt"]);
    git(repoRoot, ["commit", "-q", "-m", "Base desktop release"]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("confirms a target commit that is already in HEAD's ancestry", async () => {
    const head = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await expect(verifyMergeApplied(repoRoot, head)).resolves.toEqual({
      ok: true,
      headCommit: head,
    });
  });

  it("survives the apply landing between verification attempts", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, "app.txt"), "target\n", "utf8");
    git(repoRoot, ["add", "app.txt"]);
    git(repoRoot, ["commit", "-q", "-m", "Target release"]);
    const targetCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    // Simulate the observed race: verification starts while the install is
    // still on the old commit, and the applier's reset lands mid-verify.
    git(repoRoot, ["reset", "-q", "--hard", baseCommit]);
    const verification = verifyMergeApplied(repoRoot, targetCommit);
    setTimeout(() => {
      git(repoRoot, ["reset", "-q", "--hard", targetCommit]);
    }, 250);
    await expect(verification).resolves.toEqual({
      ok: true,
      headCommit: targetCommit,
    });
  }, 15_000);

  it("still reports a genuinely missing commit after retries", async () => {
    const missingCommit = "0123456789abcdef0123456789abcdef01234567";
    const result = await verifyMergeApplied(repoRoot, missingCommit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("could not verify the update");
    }
  }, 15_000);

  it("reports 'still not on' for a real commit that is not an ancestor", async () => {
    git(repoRoot, ["checkout", "-q", "-b", "side"]);
    await writeFile(path.join(repoRoot, "app.txt"), "side\n", "utf8");
    git(repoRoot, ["add", "app.txt"]);
    git(repoRoot, ["commit", "-q", "-m", "Side branch commit"]);
    const sideCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    git(repoRoot, ["checkout", "-q", "main"]);
    const result = await verifyMergeApplied(repoRoot, sideCommit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`still not on ${sideCommit.slice(0, 8)}`);
    }
  }, 15_000);
});
