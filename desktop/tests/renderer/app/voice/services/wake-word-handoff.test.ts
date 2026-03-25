import { describe, expect, it, vi } from "vitest";
import {
  clearWakeWordHandoffPrefill,
  getPendingWakeWordHandoffPrefill,
  normalizeWakeWordHandoffText,
  publishWakeWordHandoffPrefill,
  resetWakeWordHandoffForTests,
  subscribeWakeWordHandoffPrefill,
} from "../../../../../src/features/voice/services/wake-word-handoff";

describe("wake-word handoff", () => {
  it("normalizes wake-word-prefixed transcripts down to the follow-up phrase", () => {
    expect(normalizeWakeWordHandoffText("Stella, how are you")).toBe(
      "how are you",
    );
    expect(normalizeWakeWordHandoffText("hey stella   what's up")).toBe(
      "what's up",
    );
    expect(normalizeWakeWordHandoffText("stella")).toBe("");
  });

  it("publishes and clears pending handoff prefills", async () => {
    resetWakeWordHandoffForTests();

    const listener = vi.fn();
    const unsubscribe = subscribeWakeWordHandoffPrefill(listener);
    const prefill = Promise.resolve("how are you");

    publishWakeWordHandoffPrefill(prefill);

    expect(getPendingWakeWordHandoffPrefill()).toBe(prefill);
    expect(listener).toHaveBeenCalledWith(prefill);

    clearWakeWordHandoffPrefill(prefill);
    expect(getPendingWakeWordHandoffPrefill()).toBeNull();

    unsubscribe();
    resetWakeWordHandoffForTests();
  });
});
