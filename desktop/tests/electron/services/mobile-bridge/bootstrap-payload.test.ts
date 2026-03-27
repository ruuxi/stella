import { describe, expect, it } from "vitest";
import { buildMobileBridgeBootstrap } from "../../../../electron/services/mobile-bridge/bootstrap-payload.js";

describe("mobile bridge bootstrap payload", () => {
  it("keeps only the allowlisted localStorage keys", () => {
    const payload = buildMobileBridgeBootstrap({
      "better-auth_cookie": "cookie-value",
      "better-auth_session_data": "session-data",
      "Stella.deviceId": "device-123",
      "stella-theme-id": "theme-dark",
      "stella-voice-shortcut": "ctrl+space",
      "stella-media-history": "[1,2,3]",
      "irrelevant-key": "ignore-me",
      "another-random-key": "ignore-me-too",
    });

    expect(payload).toEqual({
      localStorage: {
        "better-auth_cookie": "cookie-value",
        "better-auth_session_data": "session-data",
        "Stella.deviceId": "device-123",
        "stella-theme-id": "theme-dark",
        "stella-voice-shortcut": "ctrl+space",
        "stella-media-history": "[1,2,3]",
      },
    });
  });

  it("returns an empty bootstrap payload when nothing matches", () => {
    expect(
      buildMobileBridgeBootstrap({
        foo: "bar",
        baz: "qux",
      }),
    ).toEqual({ localStorage: {} });
  });
});
