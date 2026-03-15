import { describe, expect, it, vi } from "vitest";
import {
  createShellState,
  handleSkillBash,
  normalizeAppAgentShellCommand,
} from "../../../electron/core/runtime/tools/shell.js";

const { writeSecretFileMock, removeSecretFileMock } = vi.hoisted(() => ({
  writeSecretFileMock: vi.fn(),
  removeSecretFileMock: vi.fn(),
}));

vi.mock("../../../electron/core/runtime/tools/utils", async () => {
  const actual = await vi.importActual<typeof import("../../../electron/core/runtime/tools/utils.js")>(
    "../../../electron/core/runtime/tools/utils",
  );
  return {
    ...actual,
    writeSecretFile: writeSecretFileMock,
    removeSecretFile: removeSecretFileMock,
  };
});

describe("SkillBash secret mounts", () => {
  it("rejects skills that are not enabled in the tool context", async () => {
    const state = createShellState(async () => "secret", "/tmp/test-state");
    state.skillCache = [
      {
        id: "demo-skill",
        name: "Demo",
        description: "Demo skill",
        markdown: "",
        agentTypes: ["general"],
        version: 1,
        source: "local",
        filePath: "/tmp/demo-skill.md",
      },
    ];

    const result = await handleSkillBash(
      state,
      {
        skill_id: "demo-skill",
        command: "echo hello",
      },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "req-1",
        skillIds: [],
      },
    );

    expect(result.error).toContain("Skill 'demo-skill' is not enabled.");
  });

  it("cleans up previously mounted secret files when a later mount secret is missing", async () => {
    writeSecretFileMock.mockResolvedValueOnce("/tmp/secret-a");
    removeSecretFileMock.mockResolvedValue(undefined);

    let callCount = 0;
    const state = createShellState(async () => {
      callCount += 1;
      if (callCount === 1) return "first-secret";
      return null;
    }, "/tmp/test-state");

    state.skillCache = [
      {
        id: "demo-skill",
        name: "Demo",
        description: "Demo skill",
        markdown: "",
        agentTypes: ["general"],
        version: 1,
        source: "local",
        filePath: "/tmp/demo-skill.md",
        secretMounts: {
          files: {
            "secret-a.txt": { provider: "provider-a" },
            "secret-b.txt": { provider: "provider-b" },
          },
        },
      },
    ];

    const result = await handleSkillBash(state, {
      skill_id: "demo-skill",
      command: "echo hello",
      working_directory: "/tmp",
    });

    expect(result.error).toContain("Missing secret for provider-b.");
    expect(removeSecretFileMock).toHaveBeenCalledWith("/tmp/secret-a");
  });
});

describe("normalizeAppAgentShellCommand", () => {
  it("strips inline STELLA_BROWSER_SESSION overrides from stella-browser commands", () => {
    const command =
      "STELLA_BROWSER_SESSION=youtube_open_test stella-browser open https://youtube.com && STELLA_BROWSER_SESSION=youtube_open_test stella-browser title";

    expect(normalizeAppAgentShellCommand(command)).toBe(
      "stella-browser open https://youtube.com && stella-browser title",
    );
  });
});
