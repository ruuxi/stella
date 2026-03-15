import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", async () => {
  const { DatabaseSync } = await import("node:sqlite");

  class BetterSqlite3Mock {
    private readonly db: InstanceType<typeof DatabaseSync>;

    constructor(filePath: string, options?: { readonly?: boolean }) {
      this.db = new DatabaseSync(filePath, {
        readOnly: options?.readonly === true,
      });
    }

    exec(sql: string) {
      this.db.exec(sql);
    }

    prepare(sql: string) {
      return this.db.prepare(sql);
    }

    close() {
      this.db.close();
    }
  }

  return { default: BetterSqlite3Mock };
});

const {
  convexActionMock,
  convexSetAuthMock,
  convexCloseMock,
  displayHtmlMock,
  localTaskManagerCtorMock,
} = vi.hoisted(() => ({
  convexActionMock: vi.fn(),
  convexSetAuthMock: vi.fn(),
  convexCloseMock: vi.fn().mockResolvedValue(undefined),
  displayHtmlMock: vi.fn(),
  localTaskManagerCtorMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class MockConvexClient {
    action = convexActionMock;
    setAuth = convexSetAuthMock;
    close = convexCloseMock;
    onUpdate = vi.fn(() => ({ unsubscribe: vi.fn() }));
  },
}));

vi.mock("convex/server", () => ({
  anyApi: {
    agent: {
      local_runtime: {
        webSearch: "agent.local_runtime.webSearch",
      },
    },
  },
}));

vi.mock("../../../electron/core/runtime/tools/host.js", () => ({
  createToolHost: () => ({
    executeTool: vi.fn(),
    setSkills: vi.fn(),
    registerExtensionTools: vi.fn(),
    killAllShells: vi.fn(),
    killShellsByPort: vi.fn(),
  }),
}));

vi.mock("../../../electron/core/runtime/agents/agents.js", () => ({
  loadAgentsFromHome: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../electron/core/runtime/agents/skills.js", () => ({
  loadSkillsFromHome: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../electron/core/runtime/extensions/loader.js", () => ({
  loadExtensions: vi.fn().mockResolvedValue({ tools: [], prompts: [] }),
}));

vi.mock("../../../electron/core/runtime/extensions/hook-emitter.js", () => ({
  HookEmitter: class HookEmitter {
    emit() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../electron/core/runtime/tasks/local-task-manager.js", () => ({
  LocalTaskManager: class LocalTaskManager {
    constructor(opts: unknown) {
      localTaskManagerCtorMock(opts);
    }

    shutdown() {}
  },
}));

vi.mock("../../../electron/core/runtime/remote-turn-bridge.js", () => ({
  createRemoteTurnBridge: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    sync: vi.fn(),
  }),
}));

const { createStellaHostRunner } = await import(
  "../../../electron/core/runtime/runner.js"
);
const { createDesktopDatabase } = await import(
  "../../../electron/storage/database.js"
);
const { RuntimeStore } = await import(
  "../../../electron/storage/runtime-store.js"
);
const { TranscriptMirror } = await import(
  "../../../electron/storage/transcript-mirror.js"
);

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-runner-websearch-"),
  );
  tempHomes.push(dir);
  return dir;
};

describe("runtime runner WebSearch", () => {
  beforeEach(() => {
    convexActionMock.mockReset();
    convexSetAuthMock.mockReset();
    convexCloseMock.mockClear();
    displayHtmlMock.mockReset();
    localTaskManagerCtorMock.mockReset();
  });

  afterEach(() => {
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves backend non-HTML search text instead of replacing it with a placeholder", async () => {
    convexActionMock.mockResolvedValue({
      text: "Backend summary",
      results: [
        {
          title: "Release post",
          url: "https://example.com/release",
          snippet: "Summary snippet",
        },
      ],
    });

    const home = createTempHome();
    const db = createDesktopDatabase(home);
    const runtimeStore = new RuntimeStore(
      db,
      new TranscriptMirror(path.join(home, "state")),
    );
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      stellaHomePath: home,
      runtimeStore,
      displayHtml: displayHtmlMock,
    });

    runner.setConvexUrl("https://example.convex.cloud");
    runner.setAuthToken("token-1");

    await expect(
      runner.webSearch("stella release notes", { category: "news" }),
    ).resolves.toEqual({
      text: "Backend summary",
      results: [
        {
          title: "Release post",
          url: "https://example.com/release",
          snippet: "Summary snippet",
        },
      ],
    });

    expect(convexActionMock).toHaveBeenCalledWith(
      "agent.local_runtime.webSearch",
      expect.objectContaining({
        query: "stella release notes",
        category: "news",
      }),
    );
    expect(displayHtmlMock).not.toHaveBeenCalled();

    runner.stop();
    db.close();
  });

  it("configures the local task manager for up to 24 concurrent subagents", () => {
    const home = createTempHome();
    const db = createDesktopDatabase(home);
    const runtimeStore = new RuntimeStore(
      db,
      new TranscriptMirror(path.join(home, "state")),
    );
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      stellaHomePath: home,
      runtimeStore,
      displayHtml: displayHtmlMock,
    });

    expect(localTaskManagerCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxConcurrent: 24,
      }),
    );
    runner.stop();
    db.close();
  });
});
