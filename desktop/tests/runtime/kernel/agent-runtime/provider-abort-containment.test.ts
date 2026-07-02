import { describe, expect, it } from "vitest";

import {
  buildSafetyAbortSwapRoute,
  DETERMINISTIC_ABORT_THRESHOLD,
  isInstantFirstCallFailure,
  isProviderContentAbortMessage,
  ProviderAbortContainment,
  QUARANTINE_PLACEHOLDER,
  SAFETY_SWAP_STELLA_MODEL_ID,
  safetySwapStatusMessage,
} from "../../../../../runtime/kernel/agent-runtime/provider-abort-containment.js";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";
import type { Api, Model, StopReason } from "../../../../../runtime/ai/types.js";
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userMessage = (timestamp: number): AgentMessage => ({
  role: "user",
  content: "do the thing",
  timestamp,
});

const assistantMessage = (
  timestamp: number,
  stopReason: StopReason,
  errorMessage?: string,
): AgentMessage => ({
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-fable-5",
  usage,
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp,
});

const toolResultMessage = (
  timestamp: number,
  toolCallId: string,
  text: string,
): AgentMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read_email",
  content: [{ type: "text", text }],
  details: { raw: text },
  isError: false,
  timestamp,
});

const PROVIDER_ABORT_MESSAGE =
  'Provider aborted the response (stop reason: "refusal"). This is typically a provider-side refusal/safety/content-filter stop triggered by something in the request content.';

describe("isProviderContentAbortMessage", () => {
  it("matches the normalized layer-1 abort message", () => {
    expect(isProviderContentAbortMessage(PROVIDER_ABORT_MESSAGE)).toBe(true);
  });

  it("matches the legacy opaque message and content-filter stops", () => {
    expect(isProviderContentAbortMessage("An unknown error occurred")).toBe(
      true,
    );
    expect(
      isProviderContentAbortMessage("Provider finish_reason: content_filter"),
    ).toBe(true);
    expect(
      isProviderContentAbortMessage(
        'Provider stream ended with stopReason "error" but the provider supplied no error detail.',
      ),
    ).toBe(true);
  });

  it("does not match overflow / connection / empty errors", () => {
    expect(
      isProviderContentAbortMessage(
        "Context overflow: model context window is 200000 tokens.",
      ),
    ).toBe(false);
    expect(isProviderContentAbortMessage("fetch failed: ECONNRESET")).toBe(
      false,
    );
    expect(isProviderContentAbortMessage(undefined)).toBe(false);
    expect(isProviderContentAbortMessage("  ")).toBe(false);
  });
});

describe("isInstantFirstCallFailure", () => {
  it("matches a run that died on its first model call", () => {
    expect(
      isInstantFirstCallFailure([
        userMessage(1),
        assistantMessage(2, "error", PROVIDER_ABORT_MESSAGE),
      ]),
    ).toBe(true);
  });

  it("rejects runs that made progress before failing", () => {
    expect(
      isInstantFirstCallFailure([
        userMessage(1),
        assistantMessage(2, "toolUse"),
        toolResultMessage(3, "call-1", "ok"),
        assistantMessage(4, "error", PROVIDER_ABORT_MESSAGE),
      ]),
    ).toBe(false);
  });

  it("rejects successful runs", () => {
    expect(
      isInstantFirstCallFailure([userMessage(1), assistantMessage(2, "stop")]),
    ).toBe(false);
  });
});

describe("ProviderAbortContainment deterministic-abort detection", () => {
  const history = [
    userMessage(10),
    toolResultMessage(20, "call-a", "quoted email body"),
    toolResultMessage(30, "call-b", "quoted page content"),
  ];
  const failedRun = (containment: ProviderAbortContainment) =>
    containment.noteRunFailure({
      history,
      appended: [
        userMessage(40),
        assistantMessage(41, "error", PROVIDER_ABORT_MESSAGE),
      ],
      errorMessage: PROVIDER_ABORT_MESSAGE,
    });

  it("passes the original error through below the threshold", () => {
    const containment = new ProviderAbortContainment();
    expect(failedRun(containment)).toBe(PROVIDER_ABORT_MESSAGE);
    expect(containment.consecutiveInstantAbortCount).toBe(1);
  });

  it("surfaces the distinct containment error at the threshold, naming suspects", () => {
    const containment = new ProviderAbortContainment();
    failedRun(containment);
    const surfaced = failedRun(containment);

    expect(containment.consecutiveInstantAbortCount).toBe(
      DETERMINISTIC_ABORT_THRESHOLD,
    );
    expect(surfaced).toMatch(/deterministically/i);
    expect(surfaced).toContain(PROVIDER_ABORT_MESSAGE);
    // Suspect turn range: the trailing entries of the replayed history.
    expect(surfaced).toContain("toolResult:read_email");
    expect(surfaced).toMatch(/quarantine/i);
  });

  it("mentions the failed model swap when one was attempted", () => {
    const containment = new ProviderAbortContainment();
    failedRun(containment);
    const surfaced = containment.noteRunFailure({
      history,
      appended: [
        userMessage(40),
        assistantMessage(41, "error", PROVIDER_ABORT_MESSAGE),
      ],
      errorMessage: PROVIDER_ABORT_MESSAGE,
      swapAttempted: {
        fromModelId: "stella/max",
        toModelId: SAFETY_SWAP_STELLA_MODEL_ID,
      },
    });
    expect(surfaced).toContain(SAFETY_SWAP_STELLA_MODEL_ID);
    expect(surfaced).toMatch(/not model-specific/i);
  });

  it("resets the streak on success and on non-abort failures", () => {
    const containment = new ProviderAbortContainment();
    failedRun(containment);
    containment.noteRunSuccess();
    expect(containment.consecutiveInstantAbortCount).toBe(0);

    failedRun(containment);
    containment.noteRunFailure({
      history,
      appended: [userMessage(50), assistantMessage(51, "error", "tool blew up")],
      errorMessage: "tool blew up",
    });
    expect(containment.consecutiveInstantAbortCount).toBe(0);
    // A fresh pair is needed again before containment engages.
    expect(failedRun(containment)).toBe(PROVIDER_ABORT_MESSAGE);
  });
});

describe("ProviderAbortContainment quarantine", () => {
  const buildMessages = (): AgentMessage[] => [
    userMessage(10),
    toolResultMessage(20, "call-a", "older quoted content"),
    toolResultMessage(30, "call-b", "newest quoted content"),
    userMessage(40),
  ];
  const reachThreshold = (containment: ProviderAbortContainment) => {
    for (let i = 0; i < DETERMINISTIC_ABORT_THRESHOLD; i++) {
      containment.noteRunFailure({
        history: buildMessages(),
        appended: [
          userMessage(50 + i),
          assistantMessage(51 + i, "error", PROVIDER_ABORT_MESSAGE),
        ],
        errorMessage: PROVIDER_ABORT_MESSAGE,
      });
    }
  };

  it("does nothing below the threshold", () => {
    const containment = new ProviderAbortContainment();
    const messages = buildMessages();
    const application = containment.applyQuarantine(messages);
    expect(application.newlyQuarantined).toBeNull();
    expect(messages).toEqual(buildMessages());
  });

  it("masks the newest tool result once the threshold is reached", () => {
    const containment = new ProviderAbortContainment();
    reachThreshold(containment);

    const messages = buildMessages();
    const application = containment.applyQuarantine(messages);

    expect(application.newlyQuarantined?.key).toBe("30:call-b");
    const masked = messages[2];
    expect(masked.role).toBe("toolResult");
    if (masked.role === "toolResult") {
      expect(masked.content[0]?.type).toBe("text");
      expect((masked.content[0] as { text: string }).text).toContain(
        QUARANTINE_PLACEHOLDER,
      );
      expect(masked.details).toBeUndefined();
    }
    // Older sibling untouched.
    const older = messages[1];
    if (older.role === "toolResult") {
      expect((older.content[0] as { text: string }).text).toBe(
        "older quoted content",
      );
    }
  });

  it("re-masks after a history reload and advances to the next-newest entry", () => {
    const containment = new ProviderAbortContainment();
    reachThreshold(containment);
    containment.applyQuarantine(buildMessages());

    // Still failing → next resume rebuilds the array from the intact store.
    reachThreshold(containment);
    const reloaded = buildMessages();
    const application = containment.applyQuarantine(reloaded);

    expect(application.reappliedKeys).toContain("30:call-b");
    expect(application.newlyQuarantined?.key).toBe("20:call-a");
    for (const entry of reloaded) {
      if (entry.role === "toolResult") {
        expect((entry.content[0] as { text: string }).text).toContain(
          QUARANTINE_PLACEHOLDER,
        );
      }
    }
  });
});

describe("safety abort model swap (fable-5 → opus-4.8)", () => {
  const stellaFableModel = (): Model<Api> => {
    const model = {
      id: "stella/max",
      name: "max",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://relay.example/api/llm",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 0,
    } as Model<Api>;
    (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
      "claude-fable-5";
    return model;
  };

  const stellaRoute = (): ResolvedLlmRoute => ({
    route: "stella",
    model: stellaFableModel(),
    getApiKey: () => "token",
    refreshApiKey: () => "token",
  });

  it("swaps a stella fable-5 alias to the stella opus-4.8 route", () => {
    const current = stellaRoute();
    const swap = buildSafetyAbortSwapRoute(current);

    expect(swap).not.toBeNull();
    expect(swap!.fromModelId).toBe("stella/max");
    expect(swap!.toModelId).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    expect(swap!.route.route).toBe("stella");
    expect(swap!.route.model.id).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    expect(
      (swap!.route.model as Model<Api> & { upstreamModelId?: string })
        .upstreamModelId,
    ).toBe("claude-opus-4.8");
    // Auth path preserved.
    expect(swap!.route.model.baseUrl).toBe(current.model.baseUrl);
    expect(swap!.route.getApiKey).toBe(current.getApiKey);
    // Original route untouched (per-run swap, not a preference change).
    expect(current.model.id).toBe("stella/max");
  });

  it("swaps a direct openrouter fable-5 route in place", () => {
    const swap = buildSafetyAbortSwapRoute({
      route: "direct-provider",
      model: {
        ...stellaFableModel(),
        id: "anthropic/claude-fable-5",
        api: "openai-completions",
        provider: "openrouter",
        upstreamModelId: undefined,
      } as Model<Api>,
      getApiKey: () => "sk",
    });
    expect(swap?.toModelId).toBe("anthropic/claude-opus-4.8");
  });

  it("returns null for non-fable routes — no swap ping-pong", () => {
    const nonFable = buildSafetyAbortSwapRoute({
      route: "stella",
      model: {
        ...stellaFableModel(),
        id: "stella/standard",
        upstreamModelId: "gpt-5.5",
      } as Model<Api>,
      getApiKey: () => "token",
    });
    expect(nonFable).toBeNull();

    // The swapped route itself is not fable, so a second failure on the
    // swap target can never trigger another swap.
    const first = buildSafetyAbortSwapRoute(stellaRoute());
    expect(first).not.toBeNull();
    expect(buildSafetyAbortSwapRoute(first!.route)).toBeNull();
  });

  it("formats the visible swap note", () => {
    expect(
      safetySwapStatusMessage({
        fromModelId: "stella/max",
        toModelId: SAFETY_SWAP_STELLA_MODEL_ID,
      }),
    ).toBe(
      `provider safety abort on stella/max — auto-retried on ${SAFETY_SWAP_STELLA_MODEL_ID}`,
    );
  });
});
