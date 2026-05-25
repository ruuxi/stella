import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  detectThirdPartyMigrationSources,
  previewThirdPartyMigration,
  runThirdPartyMigration,
} from "../../../../../runtime/kernel/migration/third-party-importers.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

const tempRoots = new Set<string>();

const createTempRoot = async (prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.add(root);
  return root;
};

const createDb = (stellaHome: string): SqliteDatabase => {
  const db = new DatabaseSync(getDesktopDatabasePath(stellaHome), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  return db;
};

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("third-party migration importers", () => {
  it("detects Hermes and imports memory, user profile, skills, personality, model config, schedules, and report idempotently", async () => {
    const home = await createTempRoot("stella-hermes-import-home");
    const hermes = path.join(home, ".hermes");
    const stellaHome = path.join(home, ".stella");
    await mkdir(path.join(hermes, "skills", "researcher"), { recursive: true });
    await mkdir(path.join(hermes, "cron"), { recursive: true });
    await writeFile(
      path.join(hermes, "MEMORY.md"),
      "# MEMORY.md\n\n- User prefers short answers.\n- User prefers short answers.\n",
      "utf-8",
    );
    await writeFile(path.join(hermes, "USER.md"), "Name: Riley\n", "utf-8");
    await writeFile(path.join(hermes, "SOUL.md"), "Speak plainly.\n", "utf-8");
    await writeFile(
      path.join(hermes, "config.yaml"),
      "model:\n  default: openrouter/moonshotai/kimi-k2\n",
      "utf-8",
    );
    await writeFile(
      path.join(hermes, "skills", "researcher", "SKILL.md"),
      "# Researcher\n\nUse for research tasks.\n",
      "utf-8",
    );
    await writeFile(
      path.join(hermes, "cron", "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "daily",
            name: "Daily brief",
            cron: "0 9 * * *",
            prompt: "Send a daily brief.",
          },
        ],
      }),
      "utf-8",
    );

    const detected = await detectThirdPartyMigrationSources({ homeDir: home, env: {} });
    expect(detected.map((entry) => entry.source)).toContain("hermes");

    const db = createDb(stellaHome);
    try {
      const report = await runThirdPartyMigration({
        source: "hermes",
        sourceRoot: hermes,
        stellaHome,
        db,
        now: new Date("2026-05-25T10:00:00Z"),
      });
      expect(report.items.some((item) => item.kind === "channels")).toBe(true);

      const memoryRows = db
        .prepare("SELECT target, content FROM memory_entries ORDER BY target, content")
        .all() as Array<{ target: string; content: string }>;
      expect(memoryRows).toEqual([
        { target: "memory", content: "User prefers short answers." },
        { target: "user", content: "Name: Riley" },
      ]);

      const importedSkill = await readFile(
        path.join(stellaHome, "skills", "hermes-researcher", "SKILL.md"),
        "utf-8",
      );
      expect(importedSkill).toContain("name: Researcher");

      const prefs = JSON.parse(
        await readFile(path.join(stellaHome, "preferences.json"), "utf-8"),
      );
      expect(prefs.modelOverrides.orchestrator).toBe("openrouter/moonshotai/kimi-k2");
      expect(prefs.modelOverrides.general).toBe("openrouter/moonshotai/kimi-k2");

      const scheduler = JSON.parse(
        await readFile(path.join(stellaHome, "local-scheduler.json"), "utf-8"),
      );
      expect(scheduler.cronJobs).toHaveLength(1);
      expect(scheduler.cronJobs[0].payload.prompt).toBe("Send a daily brief.");

      const markdown = await readFile(report.markdownPath, "utf-8");
      expect(markdown).toContain("[Hermes](https://github.com/NousResearch/hermes-agent)");
      expect(markdown).toContain(
        "Channels skipped - re-enable in Stella settings (no setup required).",
      );

      await runThirdPartyMigration({
        source: "hermes",
        sourceRoot: hermes,
        stellaHome,
        db,
        now: new Date("2026-05-25T10:05:00Z"),
      });
      const rerunRows = db
        .prepare("SELECT target, content FROM memory_entries ORDER BY target, content")
        .all();
      expect(rerunRows).toEqual(memoryRows);
    } finally {
      db.close();
    }
  });

  it("loads OpenClaw workspace paths, resolves model aliases, imports skills, and best-effort session JSONL", async () => {
    const root = await createTempRoot("stella-openclaw-import");
    const openclaw = path.join(root, ".openclaw");
    const workspace = path.join(openclaw, "workspace");
    const stellaHome = path.join(root, ".stella");
    await mkdir(path.join(workspace, "skills", "planner"), { recursive: true });
    await mkdir(path.join(openclaw, "agents", "main", "sessions"), {
      recursive: true,
    });
    await mkdir(path.join(openclaw, "agents", "other", "sessions"), {
      recursive: true,
    });
    await writeFile(
      path.join(openclaw, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: "workspace",
            model: { primary: "Claude Opus 4.6" },
            models: {
              "anthropic/claude-opus-4-6": { alias: "Claude Opus 4.6" },
            },
          },
        },
      }),
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "MEMORY.md"),
      "- Likes morning updates.\n",
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "USER.md"),
      "User is Taylor.\n",
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "SOUL.md"),
      "Direct, calm voice.\n",
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "skills", "planner", "SKILL.md"),
      "---\nname: Planner\ndescription: Plans things.\n---\n\n# Planner\n",
      "utf-8",
    );
    await writeFile(
      path.join(openclaw, "agents", "main", "sessions", "main.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content: "hello",
          timestamp: 1_700_000_000,
        }),
        JSON.stringify({
          role: "assistant",
          content: "hi",
          timestamp: 1_700_000_001,
        }),
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(openclaw, "agents", "other", "sessions", "main.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content: "second",
          timestamp: 1_700_000_002,
        }),
        JSON.stringify({
          role: "assistant",
          content: "thread",
          timestamp: 1_700_000_003,
        }),
      ].join("\n"),
      "utf-8",
    );

    const preview = await previewThirdPartyMigration({
      source: "openclaw",
      sourceRoot: openclaw,
    });
    expect(
      preview.findings.find((finding) => finding.option === "memory")?.paths,
    ).toContain(path.join(workspace, "MEMORY.md"));

    const db = createDb(stellaHome);
    try {
      const report = await runThirdPartyMigration({
        source: "openclaw",
        sourceRoot: openclaw,
        stellaHome,
        db,
      });
      expect(
        report.items.some(
          (item) =>
            item.kind === "sessionHistory" && item.status === "imported",
        ),
      ).toBe(true);

      const prefs = JSON.parse(
        await readFile(path.join(stellaHome, "preferences.json"), "utf-8"),
      );
      expect(prefs.modelOverrides.orchestrator).toBe("anthropic/claude-opus-4-6");

      const skill = await readFile(
        path.join(stellaHome, "skills", "openclaw-planner", "SKILL.md"),
        "utf-8",
      );
      expect(skill).toContain("name: Planner");

      const importedMessages = db
        .prepare(
          "SELECT thread_key AS threadKey, entry_type AS entryType FROM runtime_thread_entries ORDER BY thread_key",
        )
        .all() as Array<{ threadKey: string; entryType: string }>;
      expect(importedMessages).toHaveLength(4);
      expect(
        new Set(importedMessages.map((message) => message.threadKey)),
      ).toEqual(
        new Set([
          "import:openclaw:agents-main-sessions-main",
          "import:openclaw:agents-other-sessions-main",
        ]),
      );

      await runThirdPartyMigration({
        source: "openclaw",
        sourceRoot: openclaw,
        stellaHome,
        db,
      });
      const rerunMessages = db
        .prepare("SELECT entry_type AS entryType FROM runtime_thread_entries")
        .all();
      expect(rerunMessages).toHaveLength(4);

      const markdown = await readFile(report.markdownPath, "utf-8");
      expect(markdown).toContain("[OpenClaw](https://github.com/openclaw/openclaw)");
      expect(markdown).toContain("The source product files were read only.");
    } finally {
      db.close();
    }
  });
});
