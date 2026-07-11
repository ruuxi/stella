import { afterEach, describe, expect, it } from "vitest";

import {
  LIVE_USER_MESSAGE_STEER_AFTER_MS,
  resolveLiveUserMessageDelivery,
} from "../../../../../runtime/kernel/runner/shared.js";

const NOW = 1_700_000_000_000;

afterEach(() => {
  delete process.env.STELLA_LIVE_USER_MESSAGE_STEER_AFTER_MS;
});

describe("resolveLiveUserMessageDelivery", () => {
  it("keeps followUp for a young run so the reply lands after the task", () => {
    expect(
      resolveLiveUserMessageDelivery({
        sessionStartedAtMs: NOW - 5_000,
        nowMs: NOW,
      }),
    ).toBe("followUp");
  });

  it("promotes to steer once the run outlives the promotion window", () => {
    expect(
      resolveLiveUserMessageDelivery({
        sessionStartedAtMs: NOW - LIVE_USER_MESSAGE_STEER_AFTER_MS - 1,
        nowMs: NOW,
      }),
    ).toBe("steer");
  });

  it("falls back to followUp when the session start time is unknown", () => {
    expect(
      resolveLiveUserMessageDelivery({
        sessionStartedAtMs: undefined,
        nowMs: NOW,
      }),
    ).toBe("followUp");
  });

  it("honors the env override", () => {
    process.env.STELLA_LIVE_USER_MESSAGE_STEER_AFTER_MS = "1000";
    expect(
      resolveLiveUserMessageDelivery({
        sessionStartedAtMs: NOW - 2_000,
        nowMs: NOW,
      }),
    ).toBe("steer");
    expect(
      resolveLiveUserMessageDelivery({
        sessionStartedAtMs: NOW - 500,
        nowMs: NOW,
      }),
    ).toBe("followUp");
  });
});
