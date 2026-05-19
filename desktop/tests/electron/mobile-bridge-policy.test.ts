import { describe, expect, it } from "vitest";
import { buildMobileBridgeBootstrap } from "../../electron/services/mobile-bridge/bootstrap-payload.js";
import {
  isMobileBridgeEventChannel,
  isMobileBridgeRequestChannel,
} from "../../electron/services/mobile-bridge/bridge-policy.js";

describe("mobile bridge policy", () => {
  it("allows the chat channels used by the mobile desktop WebView", () => {
    expect(isMobileBridgeRequestChannel("localChat:listMessages")).toBe(true);
    expect(isMobileBridgeRequestChannel("localChat:listMessagesBefore")).toBe(
      true,
    );
    expect(isMobileBridgeRequestChannel("localChat:listActivity")).toBe(true);
    expect(isMobileBridgeRequestChannel("localChat:listFiles")).toBe(true);
    expect(isMobileBridgeRequestChannel("localChat:persistDiscoveryWelcome"))
      .toBe(true);
    expect(isMobileBridgeEventChannel("localChat:updated")).toBe(true);
  });

  it("bootstraps welcome dialog state into the mobile WebView", () => {
    expect(
      buildMobileBridgeBootstrap({
        "stella-welcome-dialog-seen": "true",
        "stella:post-onboarding-hints":
          '{"seededAt":1,"active":{"connect":true}}',
        "stella.home.ideasSeen.v2.default": '{"Ideas":"abcd"}',
        "stella-billing-last-seen-plan:user@example.com": "pro",
        "stella-dictation-local": "true",
        "stella.displayPanel.width": "480",
        "better-auth_cookie": "secret",
        "stella-onboarding-complete": "true",
        "unrelated-key": "ignored",
      }),
    ).toEqual({
      localStorage: {
        "stella-welcome-dialog-seen": "true",
        "stella:post-onboarding-hints":
          '{"seededAt":1,"active":{"connect":true}}',
        "stella.home.ideasSeen.v2.default": '{"Ideas":"abcd"}',
        "stella-billing-last-seen-plan:user@example.com": "pro",
        "stella-dictation-local": "true",
        "stella-onboarding-complete": "true",
      },
    });
  });
});
