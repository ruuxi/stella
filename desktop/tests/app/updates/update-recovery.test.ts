import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStellaSourceChangeSetFromTrees,
  createStellaSourcePack,
  hashSourceTree,
  type StellaSourceTree,
} from "../../../../runtime/kernel/self-mod/stella-source-control.js";
import {
  recoverInterruptedDesktopUpdate,
  tryApplyCleanDesktopUpdate,
} from "../../../electron/ipc/updates-handlers.js";

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
        desktopInstallBaseCommit: args.activeCommit,
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
  JSON.parse(await readFile(path.join(repoRoot, "stella-install.json"), "utf8"));

const text = (content: string) => ({ kind: "text" as const, content });

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

const sourcePackRefFor = (pack: unknown) => {
  const raw = JSON.stringify(pack);
  const sha256 = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return {
    kind: "url" as const,
    url: "https://source-pack.test/source-pack.json",
    sha256,
    sizeBytes: new TextEncoder().encode(raw).byteLength,
  };
};

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

  it("discards an interrupted source-pack write before an update commit exists", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, "app.txt"), "partial source write\n");
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: {
        status: "updating",
        targetTag: null,
        targetCommit: "f".repeat(40),
        startedAt: new Date(1).toISOString(),
        finishedAt: null,
        reason: null,
        operationId: "op-source-write",
        phase: "source-pack-write",
        mode: "source-pack",
        recoveryAction: "discard",
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

    expect(result.status).toBe("discarded");
    await expect(readFile(path.join(repoRoot, "app.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    expect((await readInstallManifest(repoRoot)).lastUpdateAttempt).toMatchObject(
      {
        status: "failed",
        phase: "source-pack-write",
      },
    );
  });

  it("records completion when an interrupted source-pack update already made an owned commit", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repoRoot, "app.txt"), "source-pack target\n");
    git(repoRoot, ["commit", "-am", "Update to local source pack"]);
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: {
        status: "updating",
        targetTag: null,
        targetCommit: "e".repeat(40),
        startedAt: new Date(1).toISOString(),
        finishedAt: null,
        reason: null,
        operationId: "op-source-commit",
        phase: "native-refresh",
        mode: "source-pack",
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

    expect(result.status).toBe("completed");
    const manifest = await readInstallManifest(repoRoot);
    expect(manifest.desktopReleaseCommit).toBe("e".repeat(40));
    expect(manifest.lastUpdateAttempt.status).toBe("complete");
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
    await expect(readFile(path.join(repoRoot, ".git", "MERGE_HEAD"), "utf8"))
      .resolves.toBe("f".repeat(40));
    expect((await readInstallManifest(repoRoot)).lastUpdateAttempt).toMatchObject(
      {
        status: "failed",
        recoveryAction: "needs-agent",
      },
    );
  });

  it("does not fall back to Git when source-pack download fails", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const update = tryApplyCleanDesktopUpdate(repoRoot, repoRoot, null, {
      baseCommit,
      targetCommit: "f".repeat(40),
      releaseTag: "desktop-v9.9.9",
      sourcePackRef: {
        kind: "url",
        url: "https://source-pack.test/source-pack.json",
        sha256: `sha256:${"a".repeat(64)}`,
        sizeBytes: 1,
      },
    });
    const rejection = expect(update).rejects.toThrow("fetch failed");
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
      baseCommit,
    );
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
    git(repoRoot, ["remote", "add", "origin", repoRoot]);

    const events: string[] = [];
    const runner = {
      beginExternalSelfMod: vi.fn(async (payload: { paths: string[] }) => {
        events.push(`begin:${await readFile(path.join(repoRoot, "app.txt"), "utf8")}`);
        expect(payload.paths).toContain("app.txt");
      }),
      finishExternalSelfMod: vi.fn(async (payload: { succeeded: boolean }) => {
        events.push(`finish:${await readFile(path.join(repoRoot, "app.txt"), "utf8")}`);
        expect(payload.succeeded).toBe(true);
        await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
          installState: { desktopReleaseCommit: targetCommit },
          lastUpdateAttempt: {
            status: "complete",
            targetCommit,
          },
        });
      }),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(repoRoot, repoRoot, runner, {
      baseCommit,
      targetCommit,
      releaseTag: "desktop-v9.9.8",
    });

    expect(result.status).toBe("applied");
    expect(runner?.beginExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(runner?.finishExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["begin:base\n", "finish:git target\n"]);
  });

  it("brackets source-pack batch apply in the external self-mod morph lifecycle", async () => {
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeInstallManifest(repoRoot, {
      activeCommit: baseCommit,
      attempt: null,
    });
    await writeNativeHelperDownloadStub(repoRoot);
    const baseTree: StellaSourceTree = {
      "app.txt": text("base\n"),
    };
    const nextTree: StellaSourceTree = {
      "app.txt": text("source-pack target\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const pack = createStellaSourcePack({
      baseRevisionId: `git:${baseCommit}`,
      changeSets: [
        createStellaSourceChangeSetFromTrees({
          baseRevisionId,
          baseTree,
          nextTree,
          featureId: "desktop-release",
          description: "Desktop release desktop-v9.9.7",
        }),
      ],
      featureId: "desktop-release",
      description: "Desktop release desktop-v9.9.7",
    });
    const sourcePackRef = sourcePackRefFor(pack);
    const sourcePackRaw = JSON.stringify(pack);
    const targetCommit = "d".repeat(40);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value === sourcePackRef.url) {
          return new Response(sourcePackRaw, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const events: string[] = [];
    const runner = {
      beginExternalSelfMod: vi.fn(async (payload: { paths: string[] }) => {
        events.push(`begin:${await readFile(path.join(repoRoot, "app.txt"), "utf8")}`);
        expect(payload.paths).toContain("app.txt");
      }),
      finishExternalSelfMod: vi.fn(async (payload: { succeeded: boolean }) => {
        events.push(`finish:${await readFile(path.join(repoRoot, "app.txt"), "utf8")}`);
        expect(payload.succeeded).toBe(true);
        await expect(readInstallManifest(repoRoot)).resolves.toMatchObject({
          installState: { desktopReleaseCommit: targetCommit },
          lastUpdateAttempt: {
            status: "complete",
            targetCommit,
          },
        });
      }),
    } as unknown as Parameters<typeof tryApplyCleanDesktopUpdate>[2];

    const result = await tryApplyCleanDesktopUpdate(repoRoot, repoRoot, runner, {
      baseCommit,
      targetCommit,
      releaseTag: "desktop-v9.9.7",
      sourcePackRef,
    });

    expect(result.status).toBe("applied");
    expect(runner?.beginExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(runner?.finishExternalSelfMod).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["begin:base\n", "finish:source-pack target\n"]);
  });
});
