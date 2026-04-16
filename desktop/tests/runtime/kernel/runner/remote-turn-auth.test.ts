import { describe, expect, it } from "vitest";
import {
  getConvexErrorCode,
  isConvexUnauthenticatedError,
  shouldStopRemoteTurnForAuthFailure,
} from "../../../../../runtime/kernel/runner.js";

describe("remote-turn auth failure handling", () => {
  it("detects Convex unauthenticated errors from nested error data", () => {
    const error = {
      data: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      },
    };

    expect(getConvexErrorCode(error)).toBe("UNAUTHENTICATED");
    expect(isConvexUnauthenticatedError(error)).toBe(true);
  });

  it("ignores the first two unauthenticated failures inside the auth grace window", () => {
    const authWindowStartedAt = 1_000;
    const nowMs = authWindowStartedAt + 5_000;

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt,
        failureCount: 1,
        nowMs,
      }),
    ).toBe(false);

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt,
        failureCount: 2,
        nowMs,
      }),
    ).toBe(false);
  });

  it("stops remote-turn sync after repeated or late unauthenticated failures", () => {
    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: 1_000,
        failureCount: 3,
        nowMs: 6_000,
      }),
    ).toBe(true);

    expect(
      shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: 1_000,
        failureCount: 1,
        nowMs: 17_000,
      }),
    ).toBe(true);
  });
});
