import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RUN_MAX_ATTEMPTS,
  AGENT_RUN_RETRY_DELAYS_MS,
  agentRunRetryDelayMs,
  classifyAgentRunFailure,
  executeAgentTurnWithRetry,
  type AgentRunFailure,
  type AgentRunRetryInfo,
} from "../../../../../runtime/kernel/agent-runtime/agent-run-retry.js";
import {
  anomalousStreamStopError,
  isTransientProviderStreamAnomalyMessage,
  pausedTurnStopMessage,
  promptBlockedStopMessage,
  providerAbortedStopMessage,
} from "../../../../../runtime/ai/utils/provider-stop.js";

const noWait = async () => undefined;

describe("agent run transient retry policy", () => {
  it.each([
    {
      name: "HTTP 5xx",
      error: Object.assign(new Error("upstream failed"), { status: 500 }),
      category: "http_5xx",
    },
    {
      name: "Codex streamed server error",
      error: new Error(
        "Codex error (server_error): An error occurred while processing your request.",
      ),
      category: "http_5xx",
    },
    {
      name: "legacy Codex nested overload payload",
      error: new Error(
        'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded."}}',
      ),
      category: "http_5xx",
    },
    {
      name: "429 provider rate limit",
      error: Object.assign(new Error("Too many requests"), { status: 429 }),
      category: "rate_limit",
    },
    {
      name: "transport EOF",
      error: new Error("unexpected EOF while reading response stream"),
      category: "transport",
    },
    {
      name: "transport timeout",
      error: Object.assign(new Error("request timed out"), {
        code: "ETIMEDOUT",
      }),
      category: "transport",
    },
    {
      name: "connection reset",
      error: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      category: "transport",
    },
  ])("retries $name and resumes the same turn", async ({ error, category }) => {
    const calls: boolean[] = [];
    const prepared: AgentRunFailure[] = [];
    const retries: AgentRunRetryInfo[] = [];

    const result = await executeAgentTurnWithRetry({
      execute: async (resume) => {
        calls.push(resume);
        if (!resume) throw error;
        return { finalText: "recovered" };
      },
      prepareRetry: (failure) => {
        prepared.push(failure);
        return true;
      },
      onRetry: (info) => retries.push(info),
      random: () => 0.5,
      sleep: noWait,
    });

    expect(result).toEqual({ finalText: "recovered", attempts: 2 });
    expect(calls).toEqual([false, true]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.category).toBe(category);
    expect(retries).toEqual([
      expect.objectContaining({
        category,
        attempt: 2,
        maxAttempts: AGENT_RUN_MAX_ATTEMPTS,
        delayMs: 1_000,
      }),
    ]);
  });

  it("retries a timeout-shaped AbortError when the run was not canceled", async () => {
    const controller = new AbortController();
    const timeout = new Error("transport timeout while reading response");
    timeout.name = "AbortError";
    const execute = vi
      .fn<(resume: boolean) => Promise<{ finalText: string }>>()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ finalText: "recovered" });
    const prepareRetry = vi.fn(() => true);

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry,
      signal: controller.signal,
      random: () => 0.5,
      sleep: noWait,
    });

    expect(result).toEqual({ finalText: "recovered", attempts: 2 });
    expect(execute).toHaveBeenNthCalledWith(1, false);
    expect(execute).toHaveBeenNthCalledWith(2, true);
    expect(prepareRetry).toHaveBeenCalledOnce();
    expect(
      classifyAgentRunFailure(timeout, { signal: controller.signal }),
    ).toMatchObject({ category: "transport", retryable: true });
  });

  it("fails fast when the run signal is genuinely canceled", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort("Canceled by user");
      const error = new Error("transport timeout while reading response");
      error.name = "AbortError";
      throw error;
    });
    const prepareRetry = vi.fn(() => true);
    const onRetry = vi.fn();

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry,
      onRetry,
      signal: controller.signal,
      sleep: noWait,
    });

    expect(result).toMatchObject({
      finalText: "",
      attempts: 1,
      errorMessage: "transport timeout while reading response",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(prepareRetry).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(
      classifyAgentRunFailure(new Error("transport timeout"), {
        signal: controller.signal,
      }),
    ).toMatchObject({ category: "canceled", retryable: false });
  });

  it("uses 4 total attempts with 1s, 2.5s, and 6s backoff", async () => {
    const calls: boolean[] = [];
    const waits: number[] = [];
    const prepared: AgentRunFailure[] = [];

    const result = await executeAgentTurnWithRetry({
      execute: async (resume) => {
        calls.push(resume);
        return { finalText: "", errorMessage: "unexpected EOF" };
      },
      prepareRetry: (failure) => {
        prepared.push(failure);
        return true;
      },
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(calls).toEqual([false, true, true, true]);
    expect(prepared).toHaveLength(3);
    expect(waits).toEqual([...AGENT_RUN_RETRY_DELAYS_MS]);
    expect(result.attempts).toBe(4);
    expect(result.finalText).toBe("");
    expect(result.errorMessage).toContain(
      "Automatic recovery exhausted after 4 attempts (transport)",
    );
  });

  it.each([
    ["401 auth", "401 Unauthorized", "auth"],
    ["403 auth", "403 Forbidden", "auth"],
    ["invalid model", "invalid model: missing-model", "invalid_model_or_route"],
    ["invalid route", "route not found for provider", "invalid_model_or_route"],
    ["cancellation", "Canceled by user", "canceled"],
  ])("fails fast for %s", async (_name, message, category) => {
    const prepareRetry = vi.fn(() => true);
    const onRetry = vi.fn();
    const execute = vi.fn(async () => ({
      finalText: "",
      errorMessage: message,
    }));

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry,
      onRetry,
      sleep: noWait,
    });

    expect(result).toMatchObject({
      finalText: "",
      errorMessage: message,
      attempts: 1,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(prepareRetry).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(classifyAgentRunFailure(message).category).toBe(category);
  });

  it("turns a repeated empty completion into a clear failure instead of success", async () => {
    const execute = vi.fn(async () => ({ finalText: "" }));

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry: () => true,
      random: () => 0.5,
      sleep: noWait,
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(result.finalText).toBe("");
    expect(result.errorMessage).toContain(
      "Automatic recovery exhausted after 4 attempts (empty_response)",
    );
    expect(result.errorMessage).toContain(
      "model ended the turn without a user-visible reply",
    );
  });

  it("retries the established silent length-truncation completion", async () => {
    const truncated =
      "Run truncated: model hit the output-token cap (4096 tokens) while reasoning; no visible reply was produced.";
    const execute = vi
      .fn<
        (
          resume: boolean,
        ) => Promise<{ finalText: string; errorMessage?: string }>
      >()
      .mockResolvedValueOnce({ finalText: "", errorMessage: truncated })
      .mockResolvedValueOnce({ finalText: "recovered" });

    const result = await executeAgentTurnWithRetry({
      execute,
      prepareRetry: () => true,
      random: () => 0.5,
      sleep: noWait,
    });

    expect(result).toEqual({ finalText: "recovered", attempts: 2 });
    expect(execute).toHaveBeenNthCalledWith(1, false);
    expect(execute).toHaveBeenNthCalledWith(2, true);
    expect(classifyAgentRunFailure(truncated)).toMatchObject({
      category: "empty_response",
      retryable: true,
    });
  });

  it("keeps the configured jitter within ten percent", () => {
    expect(agentRunRetryDelayMs(0, () => 0)).toBe(900);
    expect(agentRunRetryDelayMs(1, () => 0.5)).toBe(2_500);
    expect(agentRunRetryDelayMs(2, () => 1)).toBe(6_600);
  });
});

describe("provider stream anomaly classification", () => {
  it("classifies transient stream-anomaly wordings as retryable transport failures", () => {
    const transientMessages = [
      // anomalousStreamStopError no-detail fallback (premature EOF before a
      // terminal event: LB idle-close, proxy drop).
      anomalousStreamStopError({ stopReason: "error" }).message,
      // Neutral non-safety abnormal stop, including unknown future reasons.
      providerAbortedStopMessage("network_error"),
      providerAbortedStopMessage("some_future_stop_reason"),
      providerAbortedStopMessage("failed"),
      // Anthropic pause_turn that could not be resumed in-adapter.
      pausedTurnStopMessage(),
      // Anthropic explicit premature-EOF guard.
      "Anthropic stream ended before message_stop",
    ];
    for (const message of transientMessages) {
      expect(isTransientProviderStreamAnomalyMessage(message)).toBe(true);
      expect(classifyAgentRunFailure(new Error(message))).toMatchObject({
        category: "transport",
        retryable: true,
      });
    }
  });

  it("keeps deterministic content aborts out of the transport ladder", () => {
    const contentAbortMessages = [
      // Safety-worded mid-stream abort → provider-abort containment.
      providerAbortedStopMessage("refusal"),
      providerAbortedStopMessage("SAFETY"),
      // Google blocked prompt → provider-abort containment.
      promptBlockedStopMessage("PROHIBITED_CONTENT"),
      promptBlockedStopMessage("SAFETY", "blocked by policy"),
    ];
    for (const message of contentAbortMessages) {
      expect(isTransientProviderStreamAnomalyMessage(message)).toBe(false);
      expect(classifyAgentRunFailure(new Error(message))).toMatchObject({
        category: "non_retryable",
        retryable: false,
      });
    }
  });
});
