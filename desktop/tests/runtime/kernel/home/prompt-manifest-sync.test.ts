import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { STELLA_PROMPT_IDS } from "../../../../../runtime/contracts/stella-prompts.js";
import { buildDreamSystemPrompt } from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";
import { loadParsedAgentsFromDir } from "../../../../../runtime/kernel/agents/markdown-agent-loader.js";
import { reconcileBundledAgents } from "../../../../../runtime/kernel/home/agents-sync.js";
import {
  parseRemotePromptManifest,
  recordAppliedPromptManifest,
  reconcileRemotePromptManifest,
  resolvePromptManifest,
  type RemotePromptManifest,
} from "../../../../../runtime/kernel/home/prompt-manifest-sync.js";

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

const agentId = (promptId: string) => promptId.slice("agents/".length, -3);
const agentFrontmatter = (id: string) =>
  `---\nname: ${id}\ndescription: ${id} agent\ntools: Read\nmaxAgentDepth: 1\n---\n`;

const createBundledAgents = async (): Promise<string> => {
  const bundled = await tempDir();
  for (const id of STELLA_PROMPT_IDS.filter((value) =>
    value.startsWith("agents/"),
  ).map(agentId)) {
    await writeFile(
      path.join(bundled, `${id}.md`),
      `${agentFrontmatter(id)}\nbundled ${id}\n`,
      "utf-8",
    );
  }
  return bundled;
};

const manifest = (
  publishedAt: number,
  overrides: Record<string, string> = {},
): RemotePromptManifest => {
  const prompts = STELLA_PROMPT_IDS.map((id) => {
    const content = overrides[id] ?? `default body for ${id}\n`;
    return { id, content, sha256: hash(content) };
  });
  const revision = hash(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );
  return { schemaVersion: 2, revision, publishedAt, prompts };
};

describe("remote prompt startup sync", () => {
  it("updates untouched prompts, seeds missing prompts, and preserves customized prompts with history", async () => {
    const home = await tempDir();
    const bundled = await createBundledAgents();
    const first = manifest(1, {
      "agents/orchestrator.md": "remote one\n",
      "agents/general.md": "brand new\n",
    });
    await reconcileRemotePromptManifest(first, home, bundled);
    const second = manifest(2, {
      "agents/orchestrator.md": "remote two\n",
      "agents/general.md": "brand new\n",
    });
    await reconcileRemotePromptManifest(second, home, bundled);
    await expect(
      readFile(path.join(home, "agents/orchestrator.md"), "utf-8"),
    ).resolves.toBe(`${agentFrontmatter("orchestrator")}remote two\n`);
    await expect(
      readFile(path.join(home, "agents/general.md"), "utf-8"),
    ).resolves.toBe(`${agentFrontmatter("general")}brand new\n`);

    const localEdit = `${agentFrontmatter("orchestrator")}local edit\n`;
    await writeFile(
      path.join(home, "agents/orchestrator.md"),
      localEdit,
      "utf-8",
    );
    const third = manifest(3, {
      "agents/orchestrator.md": "remote three\n",
      "agents/general.md": "brand new\n",
    });
    await reconcileRemotePromptManifest(third, home, bundled);
    await expect(
      readFile(path.join(home, "agents/orchestrator.md"), "utf-8"),
    ).resolves.toBe(localEdit);
    const localManifest = JSON.parse(
      await readFile(path.join(home, "agents/.bundled-manifest.json"), "utf-8"),
    );
    expect(localManifest.entries.orchestrator).toEqual({
      lastSyncedHash: hash(`${agentFrontmatter("orchestrator")}remote two\n`),
      sourceRevision: second.revision,
      customized: true,
    });
  });

  it("keeps bundled agent capabilities when the remote body contains frontmatter-like text", async () => {
    const home = await tempDir();
    const bundled = await createBundledAgents();
    const remote = manifest(1, {
      "agents/general.md":
        "---\ntools: exec_command, web\nmaxAgentDepth: 99\n---\nremote body\n",
    });
    await reconcileRemotePromptManifest(remote, home, bundled);
    const parsed = loadParsedAgentsFromDir(path.join(home, "agents")).find(
      (agent) => agent.id === "general",
    );
    expect(parsed?.toolsAllowlist).toEqual(["Read"]);
    expect(parsed?.maxAgentDepth).toBe(1);
    expect(parsed?.systemPrompt).toContain("tools: exec_command, web");
  });

  it("uses a validated cached manifest without renderer-provided endpoint configuration", async () => {
    const home = await tempDir();
    const remote = manifest(1, { "agents/general.md": "cached\n" });
    const fresh = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () =>
        new Response(JSON.stringify(remote), {
          status: 200,
          headers: { ETag: `"${remote.revision}"` },
        }),
    });
    expect(fresh.source).toBe("fresh-remote");

    const cached = await resolvePromptManifest({
      stellaDataDir: home,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(cached).toEqual({
      source: "cached-remote",
      manifest: remote,
      endpoint: "https://example.test/api/stella/prompts",
    });
  });

  it("applies a validated fresh manifest even when cache persistence fails", async () => {
    const home = await tempDir();
    const remote = manifest(1);
    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => new Response(JSON.stringify(remote)),
      writeCacheImpl: async () => {
        throw new Error("disk full");
      },
    });
    expect(result).toEqual({
      source: "fresh-remote",
      manifest: remote,
      endpoint: "https://example.test/api/stella/prompts",
    });
  });

  it("keeps the applied high-water mark when manifest cache persistence fails", async () => {
    const home = await tempDir();
    const endpoint = "https://example.test/api/stella/prompts";
    const olderCached = manifest(10, {
      "prompts/memory-review.md": "cached older\n",
    });
    await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => new Response(JSON.stringify(olderCached)),
    });
    const applied = manifest(30, {
      "prompts/memory-review.md": "applied newest\n",
    });
    const fresh = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => new Response(JSON.stringify(applied)),
      writeCacheImpl: async () => {
        throw new Error("disk full");
      },
    });
    expect(fresh.manifest).toEqual(applied);
    await recordAppliedPromptManifest({
      stellaDataDir: home,
      endpoint,
      manifest: applied,
    });

    const intermediate = manifest(20, {
      "prompts/memory-review.md": "rollback candidate\n",
    });
    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => new Response(JSON.stringify(intermediate)),
    });
    expect(result).toEqual({
      source: "bundled-bootstrap",
      manifest: null,
      endpoint,
    });
  });

  it("retains the applied high-water mark in memory when its durable write fails", async () => {
    const home = await tempDir();
    const endpoint = "https://memory-only.test/api/stella/prompts";
    const applied = manifest(40);
    await recordAppliedPromptManifest({
      stellaDataDir: home,
      endpoint,
      manifest: applied,
      writeStateImpl: async () => {
        throw new Error("read-only cache directory");
      },
    });

    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://memory-only.test",
      fetchImpl: async () => new Response(JSON.stringify(manifest(39))),
    });
    expect(result).toEqual({
      source: "bundled-bootstrap",
      manifest: null,
      endpoint,
    });
  });

  it("rejects an older remote publication than the cached last-known-good", async () => {
    const home = await tempDir();
    const current = manifest(20, { "prompts/memory-review.md": "current\n" });
    await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => new Response(JSON.stringify(current)),
    });
    const older = manifest(19, { "prompts/memory-review.md": "older\n" });
    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => new Response(JSON.stringify(older)),
    });
    expect(result).toEqual({
      source: "cached-remote",
      manifest: current,
      endpoint: "https://example.test/api/stella/prompts",
    });
  });

  it("rejects manifests with missing entries or invalid content-derived revisions", () => {
    const valid = manifest(1);
    expect(parseRemotePromptManifest(valid)).toEqual(valid);
    expect(
      parseRemotePromptManifest({ ...valid, prompts: valid.prompts.slice(1) }),
    ).toBeNull();
    expect(
      parseRemotePromptManifest({ ...valid, revision: "0".repeat(64) }),
    ).toBeNull();
  });

  it("never rolls a remote prompt back to an older bundle while offline", async () => {
    const home = await tempDir();
    const bundled = await createBundledAgents();
    const remote = manifest(2, {
      "agents/orchestrator.md": "newer remote\n",
    });
    await reconcileRemotePromptManifest(remote, home, bundled);
    await reconcileBundledAgents(bundled, path.join(home, "agents"), {
      sourceRevision: "bundled-bootstrap",
      seedMissingOnly: true,
      removeObsolete: false,
    });
    const expected = `${agentFrontmatter("orchestrator")}newer remote\n`;
    await expect(
      readFile(path.join(home, "agents/orchestrator.md"), "utf-8"),
    ).resolves.toBe(expected);
    const tracked = JSON.parse(
      await readFile(path.join(home, "agents/.bundled-manifest.json"), "utf-8"),
    );
    expect(tracked.entries.orchestrator).toEqual({
      lastSyncedHash: hash(expected),
      sourceRevision: remote.revision,
      customized: false,
    });
  });

  it("routes the scheduled Dream consumer through the synced home prompt", async () => {
    const home = await tempDir();
    const bundled = await createBundledAgents();
    const remote = manifest(1, {
      "prompts/dream-scheduled.md": "remote dream prompt",
    });
    await reconcileRemotePromptManifest(remote, home, bundled);
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
