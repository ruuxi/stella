import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const readRepoFile = (filePath: string) =>
  readFile(path.join(repoRoot, filePath), "utf8");

describe("Stella Browser release contract", () => {
  it("pins current.json once and shares one immutable manifest across the desktop release", async () => {
    const workflow = await readRepoFile(
      ".github/workflows/build-desktop-release.yml",
    );
    expect(workflow.match(/stella-browser\/current\.json/g) ?? []).toHaveLength(
      1,
    );
    expect(workflow).toContain("stella-browser/${source_sha}/manifest.json");
    expect(workflow).toContain("name: release-pin-stella-browser");
    expect(workflow).toContain(
      '--expected-source-sha "${{ needs.resolve-stella-browser.outputs.source-sha }}"',
    );
    expect(
      workflow.match(/stella-browser-manifest\.json/g)?.length,
    ).toBeGreaterThan(5);
  });

  it("cannot label manually-dispatched browser bytes with an arbitrary SHA", async () => {
    const workflow = await readRepoFile(
      ".github/workflows/build-stella-browser.yml",
    );
    expect(workflow).not.toContain("source_sha:");
    expect(workflow).toContain("SOURCE_SHA: ${{ github.sha }}");
    expect(workflow).toContain("group: stella-browser-current-publish");
    expect(workflow).toContain(
      'git ls-remote "https://github.com/${GITHUB_REPOSITORY}.git" refs/heads/master',
    );
    expect(workflow).toContain('if [ "$SOURCE_SHA" = "$master_sha" ]');
  });

  it("preserves the installed browser binary until its replacement is ready", async () => {
    const downloader = await readRepoFile(
      "desktop/scripts/download-stella-browser.mjs",
    );
    expect(downloader).toContain("renameSync(binaryPath, previousPath)");
    expect(downloader).toContain("renameSync(previousPath, binaryPath)");
    expect(downloader).toContain(
      "renameSync(installedManifestPath, previousManifestPath)",
    );
    expect(downloader).toContain(
      "renameSync(previousManifestPath, installedManifestPath)",
    );
    expect(downloader).not.toContain(
      'if (process.platform === "win32") rmSync(binaryPath',
    );
  });

  it("hydrates the browser automatically for install and dev entrypoints", async () => {
    const packageJson = JSON.parse(await readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.postinstall).toContain(
      "ensure-stella-browser.mjs",
    );
    expect(packageJson.scripts["electron:dev"]).toContain(
      "ensure-stella-browser.mjs --allow-build-fallback",
    );
  });

  it("rejects a pinned manifest whose sourceSha does not match", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-pin-test-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ sourceSha: "a".repeat(40), assets: {} }),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "desktop/scripts/download-stella-browser.mjs"),
          "--manifest-file",
          manifestPath,
          "--expected-source-sha",
          "b".repeat(40),
          "--platform",
          "darwin-arm64",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Stella Browser manifest sourceSha did not match",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
