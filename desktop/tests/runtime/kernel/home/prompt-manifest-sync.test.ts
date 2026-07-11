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
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { STELLA_PROMPT_IDS } from "../../../../../runtime/contracts/stella-prompts.js";
import { stellaPromptEndpointFromSiteUrl } from "../../../../../runtime/contracts/stella-api.js";
import { buildDreamSystemPrompt } from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";
import { loadParsedAgentsFromDir } from "../../../../../runtime/kernel/agents/markdown-agent-loader.js";
import { reconcileBundledAgents } from "../../../../../runtime/kernel/home/agents-sync.js";
import {
  StalePromptManifestError,
  applyPromptManifestIfCurrent,
  compactAppliedStateRecords,
  parseRemotePromptManifest,
  recordAppliedPromptManifest,
  resetPromptAppliedStateMemoryForTests,
  reconcileRemotePromptManifest,
  resolvePromptManifest,
  type RemotePromptManifest,
} from "../../../../../runtime/kernel/home/prompt-manifest-sync.js";

const roots = new Set<string>();
const promptSyncBundles = new Map<string, Promise<string>>();
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
  promptSyncBundles.clear();
});

const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const siteUrlForEndpoint = (endpoint: string) =>
  endpoint.slice(0, -"/api/stella/prompts".length);

const buildPromptSyncBundle = async (home: string): Promise<string> => {
  const existing = promptSyncBundles.get(home);
  if (existing) return existing;
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const outfile = path.join(home, "prompt-manifest-sync.bundle.mjs");
  const bundle = build({
    entryPoints: [
      path.join(repoRoot, "runtime/kernel/home/prompt-manifest-sync.ts"),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  }).then(() => outfile);
  promptSyncBundles.set(home, bundle);
  return bundle;
};

const waitForFile = async (filePath: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
};

const spawnNodeEval = (
  script: string,
  env: Record<string, string>,
): { child: ReturnType<typeof spawn>; completion: Promise<void> } => {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const completion = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}/${signal}: ${stderr}`));
    });
  });
  return { child, completion };
};

const runRecordChild = async (
  home: string,
  endpoint: string,
  publishedAt: number,
): Promise<void> => {
  const bundle = await buildPromptSyncBundle(home);
  const script = `
    const { recordAppliedPromptManifest } = await import(process.env.TEST_PROMPT_SYNC_BUNDLE);
    try {
      await recordAppliedPromptManifest({
        stellaDataDir: process.env.TEST_STELLA_HOME,
        endpoint: process.env.TEST_PROMPT_ENDPOINT,
        manifest: { publishedAt: Number(process.env.TEST_PUBLISHED_AT), revision: "a".repeat(64) },
      });
    } catch (error) {
      if (error?.name !== "StalePromptManifestError") throw error;
    }
  `;
  await spawnNodeEval(script, {
    TEST_PROMPT_SYNC_BUNDLE: pathToFileURL(bundle).href,
    TEST_STELLA_HOME: home,
    TEST_PROMPT_ENDPOINT: endpoint,
    TEST_PUBLISHED_AT: String(publishedAt),
  }).completion;
};

const spawnApplyChild = async (args: {
  home: string;
  endpoint: string;
  publishedAt: number;
  id: string;
  content: string;
  readyFile: string;
  startFile?: string;
  waitingFile?: string;
  releaseFile?: string;
  logFile: string;
  finalFile: string;
}) => {
  const bundle = await buildPromptSyncBundle(args.home);
  const script = `
    const fs = await import("node:fs/promises");
    const { applyPromptManifestIfCurrent } = await import(process.env.TEST_PROMPT_SYNC_BUNDLE);
    if (process.env.TEST_START_FILE) {
      await fs.writeFile(process.env.TEST_WAITING_FILE, "waiting\\n");
      while (true) {
        try {
          await fs.access(process.env.TEST_START_FILE);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    await applyPromptManifestIfCurrent({
      stellaDataDir: process.env.TEST_STELLA_HOME,
      endpoint: process.env.TEST_PROMPT_ENDPOINT,
      manifest: {
        publishedAt: Number(process.env.TEST_PUBLISHED_AT),
        revision: String(process.env.TEST_PUBLISHED_AT).padStart(64, "0"),
      },
      reconcile: async () => {
        await fs.appendFile(process.env.TEST_LOG_FILE, "enter:" + process.env.TEST_ID + "\\n");
        await fs.writeFile(process.env.TEST_FINAL_FILE, process.env.TEST_CONTENT);
        await fs.writeFile(process.env.TEST_READY_FILE, "ready\\n");
        if (process.env.TEST_RELEASE_FILE) {
          while (true) {
            try {
              await fs.access(process.env.TEST_RELEASE_FILE);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
        }
        await fs.appendFile(process.env.TEST_LOG_FILE, "exit:" + process.env.TEST_ID + "\\n");
      },
    });
  `;
  return spawnNodeEval(script, {
    TEST_PROMPT_SYNC_BUNDLE: pathToFileURL(bundle).href,
    TEST_STELLA_HOME: args.home,
    TEST_PROMPT_ENDPOINT: args.endpoint,
    TEST_PUBLISHED_AT: String(args.publishedAt),
    TEST_ID: args.id,
    TEST_CONTENT: args.content,
    TEST_READY_FILE: args.readyFile,
    ...(args.startFile
      ? {
          TEST_START_FILE: args.startFile,
          TEST_WAITING_FILE: args.waitingFile!,
        }
      : {}),
    ...(args.releaseFile ? { TEST_RELEASE_FILE: args.releaseFile } : {}),
    TEST_LOG_FILE: args.logFile,
    TEST_FINAL_FILE: args.finalFile,
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
          headers: { ETag: `"${remote.publishedAt}-${remote.revision}"` },
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

  it("advances an A/B/A publication and rejects the intervening stale B", async () => {
    const home = await tempDir();
    const endpoint = "https://aba-etag.example.test/api/stella/prompts";
    const siteUrl = siteUrlForEndpoint(endpoint);
    const a10 = manifest(10, { "agents/orchestrator.md": "A\n" });
    const b15 = manifest(15, { "agents/orchestrator.md": "B\n" });
    const a20 = manifest(20, { "agents/orchestrator.md": "A\n" });
    expect(a20.revision).toBe(a10.revision);

    await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl,
      fetchImpl: async () =>
        new Response(JSON.stringify(a10), {
          status: 200,
          headers: { ETag: `"10-${a10.revision}"` },
        }),
    });
    await recordAppliedPromptManifest({
      stellaDataDir: home,
      endpoint,
      manifest: a10,
    });

    let sentValidator = "";
    const refreshedA = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl,
      fetchImpl: async (_input, init) => {
        sentValidator = new Headers(init?.headers).get("if-none-match") ?? "";
        const currentEtag = `"20-${a20.revision}"`;
        return sentValidator === currentEtag
          ? new Response(null, { status: 304, headers: { ETag: currentEtag } })
          : new Response(JSON.stringify(a20), {
              status: 200,
              headers: { ETag: currentEtag },
            });
      },
    });
    expect(sentValidator).toBe(`"10-${a10.revision}"`);
    expect(refreshedA).toEqual({
      source: "fresh-remote",
      manifest: a20,
      endpoint,
    });
    await recordAppliedPromptManifest({
      stellaDataDir: home,
      endpoint,
      manifest: a20,
    });

    const staleB = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl,
      fetchImpl: async () =>
        new Response(JSON.stringify(b15), {
          status: 200,
          headers: { ETag: `"15-${b15.revision}"` },
        }),
    });
    expect(staleB).toEqual({
      source: "cached-remote",
      manifest: a20,
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

  it("rejects an A/B/A stale resolver before it can reconcile older prompts", async () => {
    const home = await tempDir();
    const endpoint = "https://aba.example.test/api/stella/prompts";
    const staleResolution = manifest(10, {
      "agents/orchestrator.md": "OLD\n",
    });
    const freshResolution = manifest(20, {
      "agents/orchestrator.md": "NEW\n",
    });
    let installed = "";

    await applyPromptManifestIfCurrent({
      stellaDataDir: home,
      endpoint,
      manifest: freshResolution,
      reconcile: async () => {
        installed = freshResolution.prompts[0].content;
      },
    });
    await expect(
      applyPromptManifestIfCurrent({
        stellaDataDir: home,
        endpoint,
        manifest: staleResolution,
        reconcile: async () => {
          installed = staleResolution.prompts[0].content;
        },
      }),
    ).rejects.toBeInstanceOf(StalePromptManifestError);
    expect(installed).toBe("NEW\n");
  });

  it("releases a crashed OS lock without revoking the next live transaction", async () => {
    const home = await tempDir();
    const endpoint = "https://kernel-lock.example.test/api/stella/prompts";
    const logFile = path.join(home, "apply.log");
    const finalFile = path.join(home, "installed.txt");
    const crashedReady = path.join(home, "crashed.ready");
    const crashedRelease = path.join(home, "never.release");
    const crashed = await spawnApplyChild({
      home,
      endpoint,
      publishedAt: 5,
      id: "CRASHED",
      content: "CRASHED",
      readyFile: crashedReady,
      releaseFile: crashedRelease,
      logFile,
      finalFile,
    });
    await waitForFile(crashedReady);
    crashed.child.kill("SIGKILL");
    await crashed.completion.catch(() => undefined);
    await writeFile(logFile, "");

    const newStart = path.join(home, "new.start");
    const newWaiting = path.join(home, "new.waiting");
    const newer = await spawnApplyChild({
      home,
      endpoint,
      publishedAt: 20,
      id: "NEW",
      content: "NEW",
      readyFile: path.join(home, "new.ready"),
      startFile: newStart,
      waitingFile: newWaiting,
      logFile,
      finalFile,
    });
    await waitForFile(newWaiting);

    const oldReady = path.join(home, "old.ready");
    const oldRelease = path.join(home, "old.release");
    const older = await spawnApplyChild({
      home,
      endpoint,
      publishedAt: 10,
      id: "OLD",
      content: "OLD",
      readyFile: oldReady,
      releaseFile: oldRelease,
      logFile,
      finalFile,
    });
    await waitForFile(oldReady);
    await writeFile(newStart, "resume\n");

    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(readFile(logFile, "utf-8")).resolves.toBe("enter:OLD\n");
    await writeFile(oldRelease, "release\n");
    await Promise.all([older.completion, newer.completion]);

    await expect(readFile(finalFile, "utf-8")).resolves.toBe("NEW");
    await expect(readFile(logFile, "utf-8")).resolves.toBe(
      "enter:OLD\nexit:OLD\nenter:NEW\nexit:NEW\n",
    );
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

  it("retains exact recovery identities and the maximum across a compaction crash", async () => {
    const home = await tempDir();
    const endpoint = "https://compact.example.test/api/stella/prompts";
    const endpointHash = hash(endpoint);
    const endpointDir = path.join(
      home,
      "cache/prompt-applied-state",
      endpointHash,
    );
    await mkdir(endpointDir, { recursive: true });
    const revision = manifest(1).revision;
    for (let publishedAt = 1; publishedAt <= 12; publishedAt += 1) {
      await writeFile(
        path.join(endpointDir, `${publishedAt}-${revision}.json`),
        `${JSON.stringify({ endpoint, publishedAt, revision })}\n`,
      );
    }

    const bundle = await buildPromptSyncBundle(home);
    const crashMarker = path.join(home, "compact-crash.ready");
    const crashScript = `
      const fs = await import("node:fs/promises");
      const { compactAppliedStateRecords } = await import(process.env.TEST_PROMPT_SYNC_BUNDLE);
      await compactAppliedStateRecords(
        process.env.TEST_STELLA_HOME,
        process.env.TEST_PROMPT_ENDPOINT,
        {
          onDurableDelete: async () => {
            await fs.writeFile(process.env.TEST_CRASH_MARKER, "ready\\n");
            await new Promise(() => setInterval(() => {}, 1_000));
          },
        },
      );
    `;
    const crashing = spawnNodeEval(crashScript, {
      TEST_PROMPT_SYNC_BUNDLE: pathToFileURL(bundle).href,
      TEST_STELLA_HOME: home,
      TEST_PROMPT_ENDPOINT: endpoint,
      TEST_CRASH_MARKER: crashMarker,
    });
    await waitForFile(crashMarker);
    crashing.child.kill("SIGKILL");
    await crashing.completion.catch(() => undefined);
    resetPromptAppliedStateMemoryForTests();

    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: siteUrlForEndpoint(endpoint),
      fetchImpl: async () => new Response(JSON.stringify(manifest(11))),
    });
    expect(result.manifest).toBeNull();

    await compactAppliedStateRecords(home, endpoint);
    const records = (await readdir(endpointDir))
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(records).toEqual(
      [9, 10, 11, 12]
        .map((publishedAt) => `${publishedAt}-${revision}.json`)
        .sort(),
    );
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
