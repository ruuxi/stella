import { describe, expect, it, vi } from "vitest";
import { createShellState, handleSkillBash } from "./tools-shell.js";

const { writeSecretFileMock, removeSecretFileMock } = vi.hoisted(() => ({
  writeSecretFileMock: vi.fn(),
  removeSecretFileMock: vi.fn(),
}));

vi.mock("./tools-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./tools-utils.js")>("./tools-utils.js");
  return {
    ...actual,
    writeSecretFile: writeSecretFileMock,
    removeSecretFile: removeSecretFileMock,
  };
});

describe("SkillBash secret mounts", () => {
  it("cleans up previously mounted secret files when a later mount secret is missing", async () => {
    writeSecretFileMock.mockResolvedValueOnce("/tmp/secret-a");
    removeSecretFileMock.mockResolvedValue(undefined);

    let callCount = 0;
    const state = createShellState(async () => {
      callCount += 1;
      if (callCount === 1) return "first-secret";
      return null;
    });

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
