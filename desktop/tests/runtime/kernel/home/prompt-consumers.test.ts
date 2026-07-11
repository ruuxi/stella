import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { PERSONALITY_TEMPLATES } from "../../../../../runtime/contracts/personality.js";
import {
  MEMORY_REVIEW_SYSTEM_PROMPT_FALLBACK,
  buildMemoryReviewSystemPrompt,
} from "../../../../../runtime/kernel/agent-runtime/memory-review.js";
import {
  reconcileSelectedPersonality,
  replacePersonalityIfHomeHashMatches,
  resolvePersonalityPresetContent,
} from "../../../../../runtime/kernel/home/personality-sync.js";
import {
  reconcileRemotePromptManifest,
  type RemotePromptManifest,
} from "../../../../../runtime/kernel/home/prompt-manifest-sync.js";
import {
  CHRONICLE_SYSTEM_PROMPT_FALLBACK,
  buildChronicleSystemPrompt,
} from "../../../../../runtime/kernel/memory/chronicle-summarizer.js";
import {
  readOrSeedPersonality,
  writePersonality,
} from "../../../../../runtime/kernel/personality/personality.js";
import { setPersonalityVoiceId } from "../../../../../runtime/kernel/preferences/local-preferences.js";
import {
  DEFAULT_ORCHESTRATOR_PROMPT,
  DEFAULT_SUBAGENT_PROMPT,
  defaultPromptForAgentType,
} from "../../../../../runtime/kernel/runner/shared.js";
import {
  THREAD_COMPACTION_SYSTEM_PROMPT_FALLBACK,
  resolveThreadCompactionSystemPrompt,
} from "../../../../../runtime/kernel/thread-runtime.js";

const roots = new Set<string>();
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-prompt-consumers-"));
  roots.add(dir);
  return dir;
};

afterEach(async () => {
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
  it("keeps every bundled markdown default identical to its in-code fallback", async () => {
    const promptDir = path.resolve(
      import.meta.dirname,
      "../../../../../runtime/extensions/stella-runtime/prompts",
    );
    const cases: Array<[string, string]> = [
      ["chronicle-summarizer", CHRONICLE_SYSTEM_PROMPT_FALLBACK],
      ["memory-review", MEMORY_REVIEW_SYSTEM_PROMPT_FALLBACK],
      ["thread-compaction", THREAD_COMPACTION_SYSTEM_PROMPT_FALLBACK],
      ["fallback-orchestrator", DEFAULT_ORCHESTRATOR_PROMPT],
      ["fallback-subagent", DEFAULT_SUBAGENT_PROMPT],
      ["personality-stella", PERSONALITY_TEMPLATES.stella],
      ["personality-professional", PERSONALITY_TEMPLATES.professional],
    ];
    for (const [id, fallback] of cases) {
      await expect(
        readFile(path.join(promptDir, `${id}.md`), "utf-8"),
      ).resolves.toBe(`${fallback.trim()}\n`);
    }
  });

  it("resolves Chronicle from home and preserves the exact offline fallback", async () => {
    const home = await tempDir();
    expect(buildChronicleSystemPrompt(undefined, "10m")).toBe(
      CHRONICLE_SYSTEM_PROMPT_FALLBACK.replaceAll(
        "{{horizon}}",
        "the last ~10 minutes",
      ),
    );
    await writePrompt(home, "chronicle-summarizer", "Across {{horizon}}.");
    expect(buildChronicleSystemPrompt(home, "6h")).toBe(
      "Across the last ~6 hours.",
    );
  });

  it("resolves memory review from home and falls back unchanged", async () => {
    const home = await tempDir();
    expect(buildMemoryReviewSystemPrompt()).toBe(
      MEMORY_REVIEW_SYSTEM_PROMPT_FALLBACK,
    );
    await writePrompt(home, "memory-review", "remote memory review");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("remote memory review");
  });

  it("resolves thread compaction from home and falls back unchanged", async () => {
    const home = await tempDir();
    expect(resolveThreadCompactionSystemPrompt()).toBe(
      THREAD_COMPACTION_SYSTEM_PROMPT_FALLBACK,
    );
    await writePrompt(home, "thread-compaction", "remote compaction");
    expect(resolveThreadCompactionSystemPrompt(home)).toBe("remote compaction");
  });

  it("resolves both generic fallback prompts from home and offline constants", async () => {
    const home = await tempDir();
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).toBe(
      DEFAULT_ORCHESTRATOR_PROMPT,
    );
    expect(defaultPromptForAgentType("unknown-agent")).toBe(
      DEFAULT_SUBAGENT_PROMPT,
    );
    await writePrompt(home, "fallback-orchestrator", "remote orchestrator");
    await writePrompt(home, "fallback-subagent", "remote subagent");
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR, home)).toBe(
      "remote orchestrator",
    );
    expect(defaultPromptForAgentType("unknown-agent", home)).toBe(
      "remote subagent",
    );
  });

  it("resolves both personality preset templates from home and offline constants", async () => {
    const home = await tempDir();
    expect(resolvePersonalityPresetContent(home, "stella")).toBe(
      `${PERSONALITY_TEMPLATES.stella.trim()}\n`,
    );
    expect(resolvePersonalityPresetContent(home, "professional")).toBe(
      `${PERSONALITY_TEMPLATES.professional.trim()}\n`,
    );
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

  it("updates an untouched pre-tracking in-code seed after its remote preset changes", async () => {
    const home = await tempDir();
    setPersonalityVoiceId(home, "stella");
    await writeFile(
      path.join(home, "PERSONALITY.md"),
      `${PERSONALITY_TEMPLATES.stella.trim()}\n`,
      "utf-8",
    );
    await writePrompt(home, "personality-stella", "new remote voice");

    await reconcileSelectedPersonality(home, "remote-r2");

    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).resolves.toBe("new remote voice\n");
    const tracked = JSON.parse(
      await readFile(path.join(home, ".personality-manifest.json"), "utf-8"),
    );
    expect(tracked.entries.PERSONALITY).toEqual({
      lastSyncedHash: sha256("new remote voice\n"),
      sourceRevision: "remote-r2",
      customized: false,
    });
  });

  it("recovers an uncustomized file when preset preference and metadata disagree", async () => {
    const home = await tempDir();
    setPersonalityVoiceId(home, "stella");
    writePersonality(home, "stella");
    setPersonalityVoiceId(home, "professional");

    await reconcileSelectedPersonality(home, "recovery-r1");

    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).resolves.toBe(`${PERSONALITY_TEMPLATES.professional.trim()}\n`);
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
});
