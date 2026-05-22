import { describe, expect, it } from "vitest";
import { createAutomationAgentCallbacks } from "../../../../../runtime/kernel/runner/orchestrator-callbacks.js";

describe("automation orchestrator callbacks", () => {
  it("exposes every run end event before resolving the automation result", async () => {
    const seen: string[] = [];
    let resolveCount = 0;
    const callbacks = createAutomationAgentCallbacks(
      (result) => {
        resolveCount += 1;
        seen.push(result.finalText);
      },
      {
        onEnd: (event) => {
          seen.push(`hook:${event.finalText}`);
        },
      },
    );

    callbacks.onEnd({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      userMessageId: "message-1",
      finalText: "orchestrator follow-up",
      persisted: true,
      responseTarget: {
        type: "agent_terminal_notice",
        agentId: "task-1",
        terminalState: "completed",
      },
    });

    expect(resolveCount).toBe(1);
    expect(seen).toEqual([
      "hook:orchestrator follow-up",
      "orchestrator follow-up",
    ]);
  });
});
