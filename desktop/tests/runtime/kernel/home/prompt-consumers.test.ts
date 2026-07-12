import { createHash } from "node:crypto";
import fs, {
  closeSync,
  ftruncateSync,
  openSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { buildMemoryReviewSystemPrompt } from "../../../../../runtime/kernel/agent-runtime/memory-review.js";
import {
  reconcileSelectedPersonality,
  replacePersonalityIfHomeHashMatches,
  resolvePersonalityPresetContent,
} from "../../../../../runtime/kernel/home/personality-sync.js";
import {
  reconcileRemotePromptManifest,
  type RemotePromptManifest,
} from "../../../../../runtime/kernel/home/prompt-manifest-sync.js";
import { buildChronicleSystemPrompt } from "../../../../../runtime/kernel/memory/chronicle-summarizer.js";
import {
  readOrSeedPersonality,
  writePersonality,
} from "../../../../../runtime/kernel/personality/personality.js";
import { setPersonalityVoiceId } from "../../../../../runtime/kernel/preferences/local-preferences.js";
import { defaultPromptForAgentType } from "../../../../../runtime/kernel/runner/shared.js";
import { resolveThreadCompactionSystemPrompt } from "../../../../../runtime/kernel/thread-runtime.js";

const roots = new Set<string>();
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-prompt-consumers-"));
  roots.add(dir);
  return dir;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const writePrompt = async (home: string, id: string, content: string) => {
  await mkdir(path.join(home, "prompts"), { recursive: true });
  await writeFile(path.join(home, "prompts", `${id}.md`), content, "utf-8");
};

const sha256 = (content: string) =>
  createHash("sha256").update(content).digest("hex");

const manifest = (
  revision: string,
  prompts: Record<string, string>,
): RemotePromptManifest => ({
  schemaVersion: 2,
  revision,
  publishedAt: 1,
  prompts: Object.entries(prompts).map(([id, content]) => ({
    id: `prompts/${id}.md`,
    sha256: sha256(content),
    content,
  })),
});

describe("synced home prompt consumers", () => {
  it("resolves Chronicle only from the synchronized home prompt", async () => {
    const home = await tempDir();
    expect(buildChronicleSystemPrompt(undefined, "10m")).toBe("");
    expect(buildChronicleSystemPrompt(home, "10m")).toBe("");
    await writePrompt(home, "chronicle-summarizer", "Across {{horizon}}.");
    expect(buildChronicleSystemPrompt(home, "6h")).toBe(
      "Across the last ~6 hours.",
    );
  });

  it("resolves memory review only from home", async () => {
    const home = await tempDir();
    expect(buildMemoryReviewSystemPrompt()).toBe("");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("");
    await writePrompt(home, "memory-review", "remote memory review");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("remote memory review");
  });

  it("resolves thread compaction only from home", async () => {
    const home = await tempDir();
    expect(resolveThreadCompactionSystemPrompt()).toBe("");
    expect(resolveThreadCompactionSystemPrompt(home)).toBe("");
    await writePrompt(home, "thread-compaction", "remote compaction");
    expect(resolveThreadCompactionSystemPrompt(home)).toBe("remote compaction");
  });

  it("resolves generic fallback prompts only from home", async () => {
    const home = await tempDir();
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).toBe("");
    expect(defaultPromptForAgentType("unknown-agent")).toBe("");
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR, home)).toBe("");
    expect(defaultPromptForAgentType("unknown-agent", home)).toBe("");
    await writePrompt(home, "fallback-orchestrator", "remote orchestrator");
    await writePrompt(home, "fallback-subagent", "remote subagent");
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR, home)).toBe(
      "remote orchestrator",
    );
    expect(defaultPromptForAgentType("unknown-agent", home)).toBe(
      "remote subagent",
    );
  });

  it("resolves personality preset templates only from home", async () => {
    const home = await tempDir();
    expect(resolvePersonalityPresetContent(home, "stella")).toBe("");
    expect(resolvePersonalityPresetContent(home, "professional")).toBe("");
    expect(readOrSeedPersonality(home)).toBe("");
    expect(writePersonality(home, "professional")).toBe("");
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).rejects.toThrow();
    await writePrompt(home, "personality-stella", "remote Stella voice");
    await writePrompt(
      home,
      "personality-professional",
      "remote professional voice",
    );
    expect(resolvePersonalityPresetContent(home, "stella")).toBe(
      "remote Stella voice\n",
    );
    expect(resolvePersonalityPresetContent(home, "professional")).toBe(
      "remote professional voice\n",
    );
  });
});

describe("PERSONALITY.md sync tracking", () => {
  it("updates untouched content, preserves customization, and keeps preset selection intentional", async () => {
    const home = await tempDir();
    setPersonalityVoiceId(home, "stella");
    await reconcileRemotePromptManifest(
      manifest("r1", {
        "personality-stella": "Stella remote v1\n",
        "personality-professional": "Professional remote v1\n",
      }),
      home,
      home,
    );
    await reconcileSelectedPersonality(home, "r1");
    expect(readOrSeedPersonality(home)).toBe("Stella remote v1");

    await reconcileRemotePromptManifest(
      manifest("r2", {
        "personality-stella": "Stella remote v2\n",
        "personality-professional": "Professional remote v2\n",
      }),
      home,
      home,
    );
    await reconcileSelectedPersonality(home, "r2");
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).resolves.toBe("Stella remote v2\n");

    await writeFile(
      path.join(home, "PERSONALITY.md"),
      "my custom voice\n",
      "utf-8",
    );
    await reconcileRemotePromptManifest(
      manifest("r3", {
        "personality-stella": "Stella remote v3\n",
        "personality-professional": "Professional remote v3\n",
      }),
      home,
      home,
    );
    await reconcileSelectedPersonality(home, "r3");
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).resolves.toBe("my custom voice\n");
    const customized = JSON.parse(
      await readFile(path.join(home, ".personality-manifest.json"), "utf-8"),
    );
    expect(customized.entries.PERSONALITY).toEqual({
      lastSyncedHash: sha256("Stella remote v2\n"),
      sourceRevision: "r2",
      customized: true,
    });

    setPersonalityVoiceId(home, "professional");
    expect(writePersonality(home, "professional")).toBe(
      "Professional remote v3",
    );
    const selected = JSON.parse(
      await readFile(path.join(home, ".personality-manifest.json"), "utf-8"),
    );
    expect(selected.entries.PERSONALITY).toEqual({
      lastSyncedHash: sha256("Professional remote v3\n"),
      sourceRevision: "r3",
      customized: false,
    });
  });

  it("adopts a pre-tracking lazy seed when it still matches the selected preset", async () => {
    const home = await tempDir();
    setPersonalityVoiceId(home, "stella");
    await writePrompt(home, "personality-stella", "matching preset");
    await writeFile(
      path.join(home, "PERSONALITY.md"),
      "matching preset\n",
      "utf-8",
    );
    const report = await reconcileSelectedPersonality(home, "remote-r1");
    expect(report.actions).toEqual([
      expect.objectContaining({ type: "adopt-identical", id: "PERSONALITY" }),
    ]);
  });

  it("recovers an uncustomized file when preset preference and metadata disagree", async () => {
    const home = await tempDir();
    await writePrompt(home, "personality-stella", "Stella remote voice");
    await writePrompt(
      home,
      "personality-professional",
      "Professional remote voice",
    );
    setPersonalityVoiceId(home, "stella");
    writePersonality(home, "stella");
    setPersonalityVoiceId(home, "professional");

    await reconcileSelectedPersonality(home, "recovery-r1");

    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).resolves.toBe("Professional remote voice\n");
  });

  it("does not replace a direct edit made after the untouched hash decision", async () => {
    const home = await tempDir();
    const target = path.join(home, "PERSONALITY.md");
    const staged = path.join(home, "PERSONALITY.md.staged");
    await writeFile(target, "previous untouched value\n", "utf-8");
    const expectedHomeHash = sha256("previous untouched value\n");
    await writeFile(staged, "incoming remote value\n", "utf-8");

    expect(
      replacePersonalityIfHomeHashMatches({
        target,
        staged,
        expectedHomeHash,
        onAfterTargetCaptured: () => {
          writeFileSync(target, "concurrent direct edit\n", "utf-8");
        },
      }),
    ).toBe(false);
    await expect(readFile(target, "utf-8")).resolves.toBe(
      "concurrent direct edit\n",
    );
  });

  it("preserves a write through the old descriptor during target verification", async () => {
    const home = await tempDir();
    const target = path.join(home, "PERSONALITY.md");
    const staged = path.join(home, "PERSONALITY.md.staged");
    await writeFile(target, "previous untouched value\n", "utf-8");
    const expectedHomeHash = sha256("previous untouched value\n");
    await writeFile(staged, "incoming remote value\n", "utf-8");
    const oldDescriptor = openSync(target, "r+");

    try {
      expect(
        replacePersonalityIfHomeHashMatches({
          target,
          staged,
          expectedHomeHash,
          onAfterInstalledTargetVerified: () => {
            ftruncateSync(oldDescriptor, 0);
            writeSync(oldDescriptor, "descriptor edit\n", 0, "utf-8");
          },
        }),
      ).toBe(false);
    } finally {
      closeSync(oldDescriptor);
    }
    await expect(readFile(target, "utf-8")).resolves.toBe("descriptor edit\n");
  });

  it("preserves both a target-path edit and an old-descriptor edit during recovery", async () => {
    const home = await tempDir();
    const target = path.join(home, "PERSONALITY.md");
    const staged = path.join(home, "PERSONALITY.md.staged");
    await writeFile(target, "previous untouched value\n", "utf-8");
    const expectedHomeHash = sha256("previous untouched value\n");
    await writeFile(staged, "incoming remote value\n", "utf-8");
    const oldDescriptor = openSync(target, "r+");

    try {
      expect(
        replacePersonalityIfHomeHashMatches({
          target,
          staged,
          expectedHomeHash,
          onAfterInstalledTargetVerified: () => {
            ftruncateSync(oldDescriptor, 0);
            writeSync(oldDescriptor, "descriptor edit\n", 0, "utf-8");
            writeFileSync(target, "target-path edit\n", "utf-8");
          },
        }),
      ).toBe(false);
    } finally {
      closeSync(oldDescriptor);
    }

    await expect(readFile(target, "utf-8")).resolves.toBe("target-path edit\n");
    const conflictContents = await Promise.all(
      (await readdir(home))
        .filter((name) => name.startsWith("PERSONALITY.md.conflict-"))
        .map((name) => readFile(path.join(home, name), "utf-8")),
    );
    expect(conflictContents).toContain("descriptor edit\n");
    expect((await readdir(home)).some((name) => name.includes(".cas-"))).toBe(
      false,
    );
  });

  it("recovers the guard when the installed target disappears mid-check", async () => {
    const home = await tempDir();
    const target = path.join(home, "PERSONALITY.md");
    const staged = path.join(home, "PERSONALITY.md.staged");
    await writeFile(target, "previous untouched value\n", "utf-8");
    await writeFile(staged, "incoming remote value\n", "utf-8");

    expect(() =>
      replacePersonalityIfHomeHashMatches({
        target,
        staged,
        expectedHomeHash: sha256("previous untouched value\n"),
        onAfterInstalledTargetVerified: () => unlinkSync(target),
      }),
    ).toThrow();

    await expect(readFile(target, "utf-8")).resolves.toBe(
      "previous untouched value\n",
    );
    const files = await readdir(home);
    expect(files.some((name) => name.includes(".cas-"))).toBe(false);
    expect(files.some((name) => name.includes(".installed-"))).toBe(false);
  });

  it("finalizes the guard when staged cleanup fails after a successful link", async () => {
    const home = await tempDir();
    const target = path.join(home, "PERSONALITY.md");
    const staged = path.join(home, "PERSONALITY.md.staged");
    await writeFile(target, "previous untouched value\n", "utf-8");
    await writeFile(staged, "incoming remote value\n", "utf-8");
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (filePath === staged) {
        throw Object.assign(new Error("injected staged unlink failure"), {
          code: "EIO",
        });
      }
      return originalUnlink(filePath);
    });

    expect(
      replacePersonalityIfHomeHashMatches({
        target,
        staged,
        expectedHomeHash: sha256("previous untouched value\n"),
      }),
    ).toBe(true);
    await expect(readFile(target, "utf-8")).resolves.toBe(
      "incoming remote value\n",
    );
    await expect(readFile(staged, "utf-8")).rejects.toThrow();
    const files = await readdir(home);
    expect(files.some((name) => name.includes(".cas-"))).toBe(false);
    const conflicts = await Promise.all(
      files
        .filter((name) => name.startsWith("PERSONALITY.md.conflict-"))
        .map((name) => readFile(path.join(home, name), "utf-8")),
    );
    expect(conflicts).toContain("previous untouched value\n");
  });
});
