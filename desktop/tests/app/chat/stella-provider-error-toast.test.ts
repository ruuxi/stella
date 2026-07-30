import { describe, expect, it } from "vitest";

import {
  detectLlmRouteFailureKind,
  formatLlmRouteFailure,
  type LlmRouteFailure,
} from "../../../../runtime/ai/llm-route-failure.js";
import {
  isStellaLimitOrAuthReason,
  resolveStellaProviderErrorToast,
} from "@/features/chat/streaming/stella-provider-error-toast";

// Locks the runtime↔desktop contract: route failures are matched by their
// stable marker, not by human-readable prose. A reworded message must keep the
// marker (round-trip test) AND keep mapping to a specific toast.
describe("llm route failure → toast", () => {
  const failures: LlmRouteFailure[] = [
    {
      kind: "missing-credential",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-opus-4.8",
    },
    {
      kind: "unknown-model",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-opus-9.9",
    },
    {
      kind: "unsupported-provider",
      provider: "totallyfake",
      model: "totallyfake/some-model",
    },
    { kind: "no-stella-route" },
  ];

  it("round-trips format → detect for every failure kind", () => {
    for (const failure of failures) {
      expect(detectLlmRouteFailureKind(formatLlmRouteFailure(failure))).toBe(
        failure.kind,
      );
    }
  });

  it("maps each route failure to a specific (non-generic) toast", () => {
    for (const failure of failures) {
      const toast = resolveStellaProviderErrorToast(
        formatLlmRouteFailure(failure),
      );
      expect(toast.title).not.toBe("Stella hit a snag");
      expect(toast.variant).toBe("error");
      expect(toast.action).toBeDefined();
    }
  });

  it("missing-credential surfaces the BYOK key toast with both actions", () => {
    const toast = resolveStellaProviderErrorToast(
      formatLlmRouteFailure({
        kind: "missing-credential",
        provider: "openrouter",
        model: "openrouter/anthropic/claude-opus-4.8",
      }),
    );
    expect(toast.title).toBe("Provider key needed");
    expect(toast.action).toBeDefined();
    expect(toast.secondaryAction).toBeDefined();
  });

  it("surfaces Claude Code login failures with the CLI login steps", () => {
    const reason =
      "[claude-code/login-required] Claude Code needs login. Open Terminal, run `claude`, then use `/login`.";

    expect(isStellaLimitOrAuthReason(reason)).toBe(true);
    expect(resolveStellaProviderErrorToast(reason)).toMatchObject({
      title: "Claude Code needs login",
      description:
        "Open Terminal, run claude, then use /login. Retry in Stella after Claude Code confirms you are signed in.",
      variant: "error",
      duration: 10000,
    });
  });

  it("surfaces the ChatGPT Pro usage limit with a model-switch action", () => {
    const reason =
      "You have hit your ChatGPT usage limit (pro plan). Try again in ~7868 min.";

    expect(isStellaLimitOrAuthReason(reason)).toBe(true);
    expect(resolveStellaProviderErrorToast(reason)).toMatchObject({
      title: "ChatGPT usage limit reached",
      description:
        "Your ChatGPT Pro usage limit has been reached. Choose another model now, or try again after it resets.",
      variant: "error",
      duration: 10000,
      action: expect.objectContaining({ label: "Choose model" }),
      secondaryAction: expect.any(Object),
    });
  });
});
