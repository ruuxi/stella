import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  reconcileRemotePromptManifest,
  resolvePromptManifest,
  type RemotePromptManifest,
} from "../../../../../runtime/kernel/home/prompt-manifest-sync.js";
import { reconcileBundledAgents } from "../../../../../runtime/kernel/home/agents-sync.js";
import { buildDreamSystemPrompt } from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";

const roots = new Set<string>();
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-prompts-"));
  roots.add(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const manifest = (
  revision: string,
  values: Record<string, string>,
): RemotePromptManifest => ({
  schemaVersion: 1,
  revision,
  prompts: Object.entries(values).map(([id, content]) => ({
    id,
    content,
    sha256: hash(content),
  })),
});

describe("remote prompt startup sync", () => {
  it("updates untouched prompts, seeds new prompts, and preserves customized prompts with history", async () => {
    const home = await tempDir();
    await reconcileRemotePromptManifest(
      manifest("r1", { "agents/orchestrator.md": "remote one" }),
      home,
    );
    await reconcileRemotePromptManifest(
      manifest("r2", {
        "agents/orchestrator.md": "remote two",
        "agents/new_agent.md": "brand new",
      }),
      home,
    );
    await expect(
      readFile(path.join(home, "agents/orchestrator.md"), "utf-8"),
    ).resolves.toBe("remote two");
    await expect(
      readFile(path.join(home, "agents/new_agent.md"), "utf-8"),
    ).resolves.toBe("brand new");

    await writeFile(
      path.join(home, "agents/orchestrator.md"),
      "local edit",
      "utf-8",
    );
    await reconcileRemotePromptManifest(
      manifest("r3", { "agents/orchestrator.md": "remote three" }),
      home,
    );
    await expect(
      readFile(path.join(home, "agents/orchestrator.md"), "utf-8"),
    ).resolves.toBe("local edit");
    const localManifest = JSON.parse(
      await readFile(path.join(home, "agents/.bundled-manifest.json"), "utf-8"),
    );
    expect(localManifest.entries.orchestrator).toEqual({
      lastSyncedHash: hash("remote two"),
      sourceRevision: "r2",
      customized: true,
    });
  });

  it("uses a validated cached manifest when the startup fetch is offline", async () => {
    const home = await tempDir();
    const remote = manifest("cached-r1", { "agents/general.md": "cached" });
    const fresh = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () =>
        new Response(JSON.stringify(remote), {
          status: 200,
          headers: { ETag: '"cached-r1"' },
        }),
    });
    expect(fresh.source).toBe("fresh-remote");

    const cached = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(cached).toEqual({ source: "cached-remote", manifest: remote });
  });

  it("never rolls a remote prompt back to an older bundle while offline", async () => {
    const home = await tempDir();
    const bundled = await tempDir();
    await mkdir(bundled, { recursive: true });
    await writeFile(
      path.join(bundled, "orchestrator.md"),
      "older bundle",
      "utf-8",
    );
    await reconcileRemotePromptManifest(
      manifest("remote-r2", { "agents/orchestrator.md": "newer remote" }),
      home,
    );
    await reconcileBundledAgents(bundled, path.join(home, "agents"), {
      sourceRevision: "bundled-bootstrap",
      seedMissingOnly: true,
      removeObsolete: false,
    });
    await expect(
      readFile(path.join(home, "agents/orchestrator.md"), "utf-8"),
    ).resolves.toBe("newer remote");
    const tracked = JSON.parse(
      await readFile(path.join(home, "agents/.bundled-manifest.json"), "utf-8"),
    );
    expect(tracked.entries.orchestrator).toEqual({
      lastSyncedHash: hash("newer remote"),
      sourceRevision: "remote-r2",
      customized: false,
    });
  });

  it("routes the scheduled Dream consumer through the synced home prompt", async () => {
    const home = await tempDir();
    await reconcileRemotePromptManifest(
      manifest("dream-r1", {
        "prompts/dream-scheduled.md": "remote dream prompt",
      }),
      home,
    );
    expect(buildDreamSystemPrompt(home)).toBe("remote dream prompt");
  });

  it("migrates legacy hash-only manifests without losing update eligibility", async () => {
    const home = await tempDir();
    const bundled = await tempDir();
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(path.join(home, "agents/general.md"), "old", "utf-8");
    await writeFile(path.join(bundled, "general.md"), "new", "utf-8");
    await writeFile(
      path.join(home, "agents/.bundled-manifest.json"),
      JSON.stringify({ version: 1, entries: { general: hash("old") } }),
      "utf-8",
    );
    await reconcileBundledAgents(bundled, path.join(home, "agents"));
    await expect(
      readFile(path.join(home, "agents/general.md"), "utf-8"),
    ).resolves.toBe("new");
    const migrated = JSON.parse(
      await readFile(path.join(home, "agents/.bundled-manifest.json"), "utf-8"),
    );
    expect(migrated.version).toBe(2);
    expect(migrated.entries.general).toEqual(
      expect.objectContaining({
        customized: false,
        lastSyncedHash: hash("new"),
      }),
    );
  });
});
