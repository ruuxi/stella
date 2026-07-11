import { describe, expect, it } from "vitest";

import { executeToolWithInactivityBound } from "../../../../../runtime/kernel/integrations/tool-inactivity.js";

describe("executeToolWithInactivityBound", () => {
  it("cancels a tool that never settles and returns an error result", async () => {
    let toolSignal: AbortSignal | undefined;
    const result = await executeToolWithInactivityBound({
      toolName: "Recall",
      timeoutMs: 25,
      run: (signal) => {
        toolSignal = signal;
        return new Promise(() => {});
      },
    });

    expect(result.error).toContain("produced no output");
    expect(toolSignal?.aborted).toBe(true);
  });

  it("keeps a tool alive while it reports activity", async () => {
    const result = await executeToolWithInactivityBound({
      toolName: "exec_command",
      timeoutMs: 40,
      run: async (_signal, onActivity) => {
        for (let i = 0; i < 4; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          onActivity();
        }
        return { result: "done" };
      },
    });

    expect(result).toEqual({ result: "done" });
  });

  it("propagates non-timeout tool failures unchanged", async () => {
    await expect(
      executeToolWithInactivityBound({
        toolName: "spawn_agent",
        timeoutMs: 10_000,
        run: async () => {
          throw new Error("backend unavailable");
        },
      }),
    ).rejects.toThrow("backend unavailable");
  });

  it("composes the outer abort signal into the tool signal", async () => {
    const outer = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const execution = executeToolWithInactivityBound({
      toolName: "search",
      timeoutMs: 10_000,
      signal: outer.signal,
      run: (signal) => {
        toolSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    outer.abort();
    await expect(execution).rejects.toThrow("aborted");
    expect(toolSignal?.aborted).toBe(true);
  });

  it("disables the bound when timeout is <= 0", async () => {
    const result = await executeToolWithInactivityBound({
      toolName: "search",
      timeoutMs: 0,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { result: "slow but fine" };
      },
    });
    expect(result).toEqual({ result: "slow but fine" });
  });
});
