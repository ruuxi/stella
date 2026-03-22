import { describe, expect, it, vi } from "vitest";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createUserPromptMessage,
} from "../../../packages/runtime-kernel/agent-runtime/run-preparation.js";

describe("agent runtime preparation helpers", () => {
  it("applies before_agent_start replace and append hooks to the orchestrator system prompt", async () => {
    const baseOpts = {
      agentType: "orchestrator",
      agentContext: {
        systemPrompt: "Base system",
        dynamicContext: "",
        defaultSkills: [],
        skillIds: [],
      },
    };

    await expect(
      buildRuntimeSystemPrompt({
        ...baseOpts,
        hookEmitter: {
          emit: vi.fn().mockResolvedValue({
            systemPromptReplace: "Replaced system",
          }),
        },
      } as never),
    ).resolves.toBe("Replaced system");

    await expect(
      buildRuntimeSystemPrompt({
        ...baseOpts,
        hookEmitter: {
          emit: vi.fn().mockResolvedValue({
            systemPromptAppend: "Appended note",
          }),
        },
      } as never),
    ).resolves.toContain("Appended note");
  });

  it("includes Stella documentation guidance for self_mod subagent prompts", () => {
    const prompt = buildSubagentSystemPrompt({
      agentType: "self_mod",
      frontendRoot: "/mock/project/stella/desktop",
      agentContext: {
        systemPrompt: "Base system",
        dynamicContext: "",
        defaultSkills: [],
        skillIds: [],
      },
    } as never);

    expect(prompt).toContain("Base system");
    expect(prompt).toContain("read `src/STELLA.md` first");
    expect(createUserPromptMessage("Solve this")).toEqual({
      role: "user",
      content: [{ type: "text", text: "Solve this" }],
    });
  });
});
