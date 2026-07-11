import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { STELLA_PROMPT_IDS } from "../../../../../runtime/contracts/stella-prompts.js";
import { stellaPromptEndpointFromSiteUrl } from "../../../../../runtime/contracts/stella-api.js";
import { buildDreamSystemPrompt } from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";
import { loadParsedAgentsFromDir } from "../../../../../runtime/kernel/agents/markdown-agent-loader.js";
import { reconcileBundledAgents } from "../../../../../runtime/kernel/home/agents-sync.js";
import {
  parseRemotePromptManifest,
  recordAppliedPromptManifest,
  resetPromptAppliedStateMemoryForTests,
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
const siteUrlForEndpoint = (endpoint: string) =>
  endpoint.slice(0, -"/api/stella/prompts".length);

const runRecordChild = async (
  home: string,
  endpoint: string,
  publishedAt: number,
): Promise<void> => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const script = `
    import { recordAppliedPromptManifest } from "./runtime/kernel/home/prompt-manifest-sync.ts";
    await recordAppliedPromptManifest({
      stellaDataDir: process.env.TEST_STELLA_HOME,
      endpoint: process.env.TEST_PROMPT_ENDPOINT,
      manifest: { publishedAt: Number(process.env.TEST_PUBLISHED_AT), revision: "a".repeat(64) },
    });
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["--eval", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TEST_STELLA_HOME: home,
        TEST_PROMPT_ENDPOINT: endpoint,
        TEST_PUBLISHED_AT: String(publishedAt),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`record child exited ${code}: ${stderr}`));
    });
  });
};

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

  it("fails before recording an applied manifest when durable persistence fails", async () => {
    const home = await tempDir();
    const endpoint = "https://memory-only.test/api/stella/prompts";
    const applied = manifest(40);
    await expect(
      recordAppliedPromptManifest({
        stellaDataDir: home,
        endpoint,
        manifest: applied,
        writeStateImpl: async () => {
          throw new Error("read-only cache directory");
        },
      }),
    ).rejects.toThrow("read-only cache directory");

    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://memory-only.test",
      fetchImpl: async () => new Response(JSON.stringify(manifest(39))),
    });
    expect(result.manifest).toEqual(manifest(39));
  });

  it("retains durable high-water marks independently for each canonical endpoint", async () => {
    const home = await tempDir();
    const endpointA = "https://a.example.test/api/stella/prompts";
    const endpointB = "https://b.example.test/api/stella/prompts";
    await recordAppliedPromptManifest({
      stellaDataDir: home,
      endpoint: endpointA,
      manifest: manifest(50),
    });
    await recordAppliedPromptManifest({
      stellaDataDir: home,
      endpoint: endpointB,
      manifest: manifest(70),
    });
    resetPromptAppliedStateMemoryForTests();

    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://a.example.test/api/stella/relay",
      fetchImpl: async () => new Response(JSON.stringify(manifest(49))),
    });
    expect(result).toEqual({
      source: "bundled-bootstrap",
      manifest: null,
      endpoint: endpointA,
    });
  });

  it("retains rollback protection from the legacy aggregate state file", async () => {
    const home = await tempDir();
    const endpoint = "https://legacy.example.test/api/stella/prompts";
    await mkdir(path.join(home, "cache"), { recursive: true });
    await writeFile(
      path.join(home, "cache/prompt-applied-state.json"),
      `${JSON.stringify({
        version: 1,
        entries: {
          [endpoint]: { publishedAt: 60, revision: "b".repeat(64) },
        },
      })}\n`,
      "utf-8",
    );

    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: siteUrlForEndpoint(endpoint),
      fetchImpl: async () => new Response(JSON.stringify(manifest(59))),
    });
    expect(result.manifest).toBeNull();
  });

  it("keeps high-water marks durable beyond the former aggregate capacity", async () => {
    const home = await tempDir();
    const longSitePath = "x".repeat(3_000);
    const endpoints = Array.from(
      { length: 100 },
      (_, index) =>
        `https://endpoint-${index}.example.test/${longSitePath}/api/stella/prompts`,
    );
    for (const [index, endpoint] of endpoints.entries()) {
      await recordAppliedPromptManifest({
        stellaDataDir: home,
        endpoint,
        manifest: manifest(index + 1),
      });
    }
    resetPromptAppliedStateMemoryForTests();

    const endpointDirs = await readdir(
      path.join(home, "cache/prompt-applied-state"),
      { withFileTypes: true },
    );
    expect(endpointDirs.filter((entry) => entry.isDirectory())).toHaveLength(
      100,
    );

    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: siteUrlForEndpoint(endpoints[81]),
      fetchImpl: async () => new Response(JSON.stringify(manifest(0))),
    });
    expect(result).toEqual({
      source: "bundled-bootstrap",
      manifest: null,
      endpoint: endpoints[81],
    });
  });

  it("handles multi-process writes without stale or paused aggregate locks", async () => {
    const home = await tempDir();
    const obsoleteLock = path.join(home, "cache/prompt-applied-state.lock");
    await mkdir(obsoleteLock, { recursive: true });
    await writeFile(path.join(obsoleteLock, "owner"), "paused-owner\n");
    const endpoints = Array.from(
      { length: 8 },
      (_, index) =>
        `https://concurrent-${index}.example.test/api/stella/prompts`,
    );
    const sharedEndpoint =
      "https://concurrent-shared.example.test/api/stella/prompts";
    await Promise.all([
      ...endpoints.map((endpoint, index) =>
        runRecordChild(home, endpoint, index + 1),
      ),
      runRecordChild(home, sharedEndpoint, 50),
      runRecordChild(home, sharedEndpoint, 51),
    ]);
    resetPromptAppliedStateMemoryForTests();

    await Promise.all(
      endpoints.map(async (endpoint, index) => {
        const result = await resolvePromptManifest({
          stellaDataDir: home,
          siteUrl: siteUrlForEndpoint(endpoint),
          fetchImpl: async () => new Response(JSON.stringify(manifest(index))),
        });
        expect(result.manifest).toBeNull();
      }),
    );
    const sharedResult = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: siteUrlForEndpoint(sharedEndpoint),
      fetchImpl: async () => new Response(JSON.stringify(manifest(49))),
    });
    expect(sharedResult.manifest).toBeNull();
    await expect(
      readFile(path.join(obsoleteLock, "owner"), "utf-8"),
    ).resolves.toBe("paused-owner\n");
  });

  it("canonicalizes accepted site URL forms to the same prompt endpoint", () => {
    expect(
      stellaPromptEndpointFromSiteUrl(
        "https://example.test/api/stella/relay/chat/completions",
      ),
    ).toBe("https://example.test/api/stella/prompts");
    expect(
      stellaPromptEndpointFromSiteUrl("https://example.test/api/stella"),
    ).toBe("https://example.test/api/stella/prompts");
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
