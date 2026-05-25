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
    await mkdir(path.join(hermes, "memories"), { recursive: true });
    await mkdir(path.join(hermes, "skills", "research", "researcher"), {
      recursive: true,
    });
    await mkdir(path.join(hermes, "cron"), { recursive: true });
    const hermesStateDb = new DatabaseSync(path.join(hermes, "state.db"));
    try {
      hermesStateDb.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER);
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          role TEXT,
          content TEXT,
          timestamp INTEGER
        );
      `);
      hermesStateDb
        .prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)")
        .run("session-1", 1_700_000_000);
      hermesStateDb
        .prepare(
          "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        )
        .run("session-1", "user", "hello from Hermes", 1_700_000_000_000);
      hermesStateDb
        .prepare(
          "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        )
        .run("session-1", "assistant", "hi from Hermes", 1_700_000_001_000);
    } finally {
      hermesStateDb.close();
    }
    await writeFile(
      path.join(hermes, "memories", "MEMORY.md"),
      "# MEMORY.md\n\n- User prefers short answers.\n- User prefers short answers.\n",
      "utf-8",
    );
    await writeFile(
      path.join(hermes, "memories", "USER.md"),
      "Name: Riley\n",
      "utf-8",
    );
    await writeFile(path.join(hermes, "SOUL.md"), "Speak plainly.\n", "utf-8");
    await writeFile(
      path.join(hermes, "config.yaml"),
      "model:\n  default: openrouter/moonshotai/kimi-k2\n",
      "utf-8",
    );
    await writeFile(
      path.join(hermes, "skills", "research", "researcher", "SKILL.md"),
      [
        "---",
        "name: Researcher",
        "description: Finds and summarizes sources.",
        "version: 2",
        "author: Hermes",
        "---",
        "",
        "# Researcher",
        "",
        "Use for research tasks.",
      ].join("\n"),
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
          {
            id: "invalid",
            name: "Invalid schedule",
            cron: "not a valid cron",
            prompt: "This should not import.",
          },
        ],
      }),
      "utf-8",
    );

    const detected = await detectThirdPartyMigrationSources({
      homeDir: home,
      env: {},
    });
    expect(detected.map((entry) => entry.source)).toContain("hermes");
    const hermesPreview = detected.find((entry) => entry.source === "hermes");
    expect(
      hermesPreview?.findings.find((finding) => finding.option === "memory")
        ?.found,
    ).toBe(true);
    expect(
      hermesPreview?.findings.find((finding) => finding.option === "user")
        ?.found,
    ).toBe(true);
    expect(
      hermesPreview?.findings.find((finding) => finding.option === "skills")
        ?.count,
    ).toBe(1);

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

      const hermesMessages = db
        .prepare(
          "SELECT thread_key AS threadKey, entry_type AS entryType FROM runtime_thread_entries ORDER BY created_at",
        )
        .all() as Array<{ threadKey: string; entryType: string }>;
      expect(hermesMessages).toHaveLength(2);
      expect(new Set(hermesMessages.map((message) => message.threadKey))).toEqual(
        new Set(["import:hermes:session-1"]),
      );

      const importedSkill = await readFile(
        path.join(stellaHome, "skills", "hermes-researcher", "SKILL.md"),
        "utf-8",
      );
      expect(importedSkill).toContain("name: Researcher");
      expect(importedSkill).toContain(
        "description: Finds and summarizes sources.",
      );
      expect(importedSkill).not.toContain("version:");
      expect(importedSkill).not.toContain("author:");

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
      expect(scheduler.cronJobs[0].nextRunAtMs).toBeGreaterThan(0);
      expect(
        report.items.some(
          (item) =>
            item.kind === "schedules" &&
            item.status === "manual" &&
            item.message.includes("Invalid schedule"),
        ),
      ).toBe(true);

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
    const workspace = path.join(openclaw, "workspace-work");
    const envWorkspace = path.join(openclaw, "workspace-env");
    const stellaHome = path.join(root, ".stella");
    const previousOpenClawWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR;
    const previousOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = path.join(openclaw, "custom-openclaw.json5");
    process.env.OPENCLAW_WORKSPACE_DIR = envWorkspace;
    await mkdir(path.join(workspace, "skills", "planner"), { recursive: true });
    await mkdir(path.join(workspace, "memory"), { recursive: true });
    await mkdir(envWorkspace, { recursive: true });
    await mkdir(path.join(openclaw, "session-store", "main"), {
      recursive: true,
    });
    await mkdir(path.join(openclaw, "agents", "main", "sessions"), {
      recursive: true,
    });
    await mkdir(path.join(openclaw, "agents", "other", "sessions"), {
      recursive: true,
    });
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH,
      `{
        // OpenClaw accepts JSON5-authored config files.
        session: { store: 'session-store/{agentId}/sessions.json' },
        agents: {
          defaults: {
            workspace: 'workspace-work',
            model: { primary: 'Claude Opus 4.6' },
            models: {
              'anthropic/claude-opus-4-6': { alias: 'Claude Opus 4.6' },
            },
          },
          list: [{ id: 'main' }],
        },
      }`,
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "memory", "2026-05-24.md"),
      "- Likes morning updates.\n",
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "USER.md"),
      "User is Taylor.\n",
      "utf-8",
    );
    await writeFile(
      path.join(envWorkspace, "USER.md"),
      "Env workspace user note.\n",
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "SOUL.md"),
      "Direct, calm voice.\n",
      "utf-8",
    );
    await writeFile(
      path.join(workspace, "skills", "planner", "SKILL.md"),
      [
        "---",
        "name: Planner",
        "description: Plans things.",
        "metadata:",
        "  platforms:",
        "    - openclaw",
        "---",
        "",
        "# Planner",
      ].join("\n"),
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
        JSON.stringify({
          role: "system",
          content: "internal instructions must stay hidden",
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
    await writeFile(
      path.join(openclaw, "session-store", "main", "sessions.json"),
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "stored-main.jsonl",
          updatedAt: 1_700_000_005,
        },
      }),
      "utf-8",
    );
    await writeFile(
      path.join(openclaw, "session-store", "main", "stored-main.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content: "stored hello",
          timestamp: 1_700_000_004,
        }),
        JSON.stringify({
          role: "assistant",
          content: "stored hi",
          timestamp: 1_700_000_005,
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const preview = await previewThirdPartyMigration({
        source: "openclaw",
        sourceRoot: openclaw,
      });
      expect(
        preview.findings.find((finding) => finding.option === "memory")?.paths,
      ).toContain(path.join(workspace, "memory", "2026-05-24.md"));
      expect(
        preview.findings.find((finding) => finding.option === "user")?.paths,
      ).toEqual(
        expect.arrayContaining([
          path.join(envWorkspace, "USER.md"),
          path.join(workspace, "USER.md"),
        ]),
      );

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
        expect(prefs.modelOverrides.orchestrator).toBe(
          "anthropic/claude-opus-4-6",
        );

        const memoryRows = db
          .prepare("SELECT target, content FROM memory_entries ORDER BY target, content")
          .all() as Array<{ target: string; content: string }>;
        expect(memoryRows).toEqual([
          { target: "memory", content: "Likes morning updates." },
          { target: "user", content: "Env workspace user note." },
          { target: "user", content: "User is Taylor." },
        ]);

        const skill = await readFile(
          path.join(stellaHome, "skills", "openclaw-planner", "SKILL.md"),
          "utf-8",
        );
        expect(skill).toContain("name: Planner");
        expect(skill).toContain("description: Plans things.");
        expect(skill).not.toContain("metadata:");
        expect(skill).not.toContain("platforms:");

        const importedMessages = db
          .prepare(
            "SELECT thread_key AS threadKey, entry_type AS entryType FROM runtime_thread_entries ORDER BY thread_key",
          )
          .all() as Array<{ threadKey: string; entryType: string }>;
        expect(importedMessages).toHaveLength(6);
        expect(
          new Set(importedMessages.map((message) => message.threadKey)),
        ).toEqual(
          new Set([
            "import:openclaw:agents-main-sessions-main",
            "import:openclaw:agents-other-sessions-main",
            "import:openclaw:session-store-main-stored-main",
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
        expect(rerunMessages).toHaveLength(6);

        const markdown = await readFile(report.markdownPath, "utf-8");
        expect(markdown).toContain(
          "[OpenClaw](https://github.com/openclaw/openclaw)",
        );
        expect(markdown).toContain("The source product files were read only.");
      } finally {
        db.close();
      }
    } finally {
      if (previousOpenClawWorkspaceDir === undefined) {
        delete process.env.OPENCLAW_WORKSPACE_DIR;
      } else {
        process.env.OPENCLAW_WORKSPACE_DIR = previousOpenClawWorkspaceDir;
      }
      if (previousOpenClawConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfigPath;
      }
    }
  });
});
