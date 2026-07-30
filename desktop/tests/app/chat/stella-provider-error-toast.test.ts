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

  it.each([
    {
      reason: "Context overflow: model context window is 128000 tokens.",
      title: "This chat is too long",
    },
    {
      reason: "Agent did not produce activity for 300s.",
      title: "The response timed out",
    },
    {
      reason: "ECONNRESET: socket connection closed unexpectedly",
      title: "Stella could not connect",
    },
    {
      reason:
        'Provider aborted the response (stop reason: "refusal"). This is a provider-side refusal.',
      title: "The model could not answer that",
    },
    {
      reason: "HTTP status 401: invalid provider credentials",
      title: "Provider access needed",
    },
    {
      reason: "HTTP status 422: request validation failed",
      title: "Stella could not send that request",
    },
    {
      reason: "HTTP status 503: upstream model unavailable",
      title: "Stella is having trouble connecting",
    },
    {
      reason: "HTTP status 429: capacity exhausted",
      title: "Model usage limit reached",
    },
    {
      reason: "Managed-model limits reached for this billing period.",
      title: "Stella needs more room",
    },
    {
      reason: "Unknown model selected-model-v9",
      title: "Model not available on your plan",
    },
    {
      reason: "Invalid token",
      title: "Please sign in again",
    },
    {
      reason: "Sign in required to continue",
      title: "Sign in to keep using Stella",
    },
  ])("maps $reason to a readable category", ({ reason, title }) => {
    expect(resolveStellaProviderErrorToast(reason)).toMatchObject({
      title,
      variant: "error",
    });
  });

  it("shows a cleaned real reason for an unmapped error", () => {
    expect(
      resolveStellaProviderErrorToast(
        "[ERROR 409:CONFLICT] The response was already finalized.",
      ),
    ).toMatchObject({
      title: "Stella could not finish",
      description: "The response was already finalized.",
      variant: "error",
      duration: 10000,
    });
  });

  it("unwraps JSON error envelopes and redacts secrets", () => {
    const toast = resolveStellaProviderErrorToast(
      'Error: {"error":{"message":"Workspace sync failed for token=sk-supersecretvalue123."}}',
    );

    expect(toast.title).toBe("Stella could not finish");
    expect(toast.description).toBe(
      "Workspace sync failed for token=[redacted]",
    );
    expect(toast.description).not.toContain("supersecret");
  });

  it("keeps opaque unknown failures readable without inventing a cause", () => {
    expect(resolveStellaProviderErrorToast("Unknown error")).toMatchObject({
      title: "Stella could not finish",
      description: "Stella could not finish this response. Please try again.",
    });
  });
});
