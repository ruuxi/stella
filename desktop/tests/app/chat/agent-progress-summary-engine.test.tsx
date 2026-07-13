// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentProgressSummaryStore } from "@/features/chat/agent-progress-summary-store";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  buildAgentProgressSignature,
  buildAgentProgressUserText,
  PROGRESS_SUMMARY_INTERVAL_MS,
  useAgentProgressSummaryEngine,
} from "@/features/chat/use-agent-progress-summary-engine";

const task = (reasoningText: string): TaskItem => ({
  id: "agent-summary-rate-limit",
  description: "Inspect Authorization: Bearer description-secret",
  agentType: "general",
  status: "running",
  statusText: "Cookie: session=status-secret",
  reasoningText,
  toolActivity: {
    toolCallId: "tool-summary",
    toolName: "exec_command",
    label: "Running command",
    argsHint: '{"command":"API_TOKEN=hint-secret bun test"}',
    state: "started",
  },
  startedAtMs: 1,
  lastUpdatedAtMs: 1,
});

function SummaryEngineHarness({ tasks }: { tasks: TaskItem[] }) {
  useAgentProgressSummaryEngine(tasks);
  return null;
}

describe("agent progress summary engine", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    agentProgressSummaryStore.reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    agentProgressSummaryStore.reset();
    vi.useRealTimers();
  });

  it("redacts the signature and exact summary prompt input", () => {
    const sensitiveTask = task(
      "Authorization: Bearer reasoning-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123",
    );
    const signature = buildAgentProgressSignature(sensitiveTask);
    const userText = buildAgentProgressUserText(sensitiveTask, [
      "Cookie: session=prior-secret",
    ]);

    for (const secret of [
      "description-secret",
      "status-secret",
      "reasoning-secret",
      "hint-secret",
      "prior-secret",
    ]) {
      expect(signature).not.toContain(secret);
      expect(userText).not.toContain(secret);
    }
  });

  it("runs once after 10 seconds and then only on 30-second ticks", async () => {
    const oneShotCompletion = vi
      .fn()
      .mockResolvedValueOnce({ text: "checking initial command" })
      .mockResolvedValue({ text: "checking updated command" });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        agent: { oneShotCompletion },
        localChat: { publishReasoningSummaries: vi.fn() },
      },
    });

    await act(async () => {
      root.render(
        <SummaryEngineHarness
          tasks={[task("Authorization: Bearer first-secret")]}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(1);
    expect(oneShotCompletion.mock.calls[0]?.[0].userText).not.toContain(
      "first-secret",
    );

    await act(async () => {
      root.render(<SummaryEngineHarness tasks={[task("second state")]} />);
      await vi.advanceTimersByTimeAsync(10_000);
      root.render(<SummaryEngineHarness tasks={[task("third state")]} />);
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_SUMMARY_INTERVAL_MS - 10_001);
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_SUMMARY_INTERVAL_MS - 1);
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(<SummaryEngineHarness tasks={[]} />);
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(3);
    expect(oneShotCompletion.mock.calls[0]?.[0].sessionKey).toBe(
      "progress-summary:agent-summary-rate-limit",
    );
    expect(oneShotCompletion.mock.calls[1]?.[0].sessionKey).toBe(
      "progress-summary:agent-summary-rate-limit",
    );
    expect(oneShotCompletion.mock.calls[2]?.[0]).toMatchObject({
      sessionKey: "progress-summary:agent-summary-rate-limit",
      closeSession: true,
    });
  });

  it("does not generate reasoning summaries for manager rows", async () => {
    const oneShotCompletion = vi.fn();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        agent: { oneShotCompletion },
        localChat: { publishReasoningSummaries: vi.fn() },
      },
    });

    await act(async () => {
      root.render(
        <SummaryEngineHarness
          tasks={[{ ...task("coordinating"), agentType: "manager" }]}
        />,
      );
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(oneShotCompletion).not.toHaveBeenCalled();
  });
});
