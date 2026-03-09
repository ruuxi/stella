import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../../packages/stella-runtime/src/tools/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/stella-runtime/src/tools/index.js")>(
    "../../../packages/stella-runtime/src/tools/index.js",
  );
  return {
    ...actual,
    createToolHost: () => ({
      executeTool: vi.fn(),
      setSkills: vi.fn(),
      registerExtensionTools: vi.fn(),
      killAllShells: vi.fn(),
      killShellsByPort: vi.fn(),
    }),
  };
});

vi.mock("../../../packages/stella-runtime/src/agents/index.js", () => ({
  loadAgentsFromHome: vi.fn().mockResolvedValue([]),
  loadSkillsFromHome: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../packages/stella-runtime/src/extensions/index.js", () => ({
  loadExtensions: vi.fn().mockResolvedValue({ tools: [], prompts: [] }),
  HookEmitter: class HookEmitter {
    emit() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../packages/stella-runtime/src/tasks/index.js", () => ({
  LocalTaskManager: class LocalTaskManager {
    constructor(opts: unknown) {
      localTaskManagerCtorMock(opts);
    }

    shutdown() {}
  },
}));

vi.mock("../../../packages/stella-runtime/src/remote-turn-bridge.js", () => ({
  createRemoteTurnBridge: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    sync: vi.fn(),
  }),
}));

const { createStellaHostRunner } = await import("../../../packages/stella-runtime/src/runner.js");

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-runner-websearch-"));
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

    const runner = createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: createTempHome(),
      displayHtml: displayHtmlMock,
    });

    runner.setConvexUrl("https://example.convex.cloud");
    runner.setAuthToken("token-1");

    await expect(runner.webSearch("stella release notes", { category: "news" })).resolves.toEqual({
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
  });

  it("configures the local task manager for up to 16 concurrent subagents", () => {
    createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: createTempHome(),
      displayHtml: displayHtmlMock,
    });

    expect(localTaskManagerCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      maxConcurrent: 16,
    }));
  });
});
