import { describe, expect, it } from "vitest";
import { buildMobileBridgeBootstrap } from "../../electron/services/mobile-bridge/bootstrap-payload.js";
import {
  MOBILE_BRIDGE_CAPABILITIES,
  MOBILE_BRIDGE_EVENT_CAPABILITIES,
  MOBILE_BRIDGE_REQUEST_CAPABILITIES,
} from "../../electron/services/mobile-bridge/capabilities.js";
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
    expect(
      isMobileBridgeRequestChannel("localChat:persistDiscoveryWelcome"),
    ).toBe(true);
    expect(isMobileBridgeRequestChannel("localChat:syncMessages")).toBe(true);
    expect(isMobileBridgeEventChannel("localChat:updated")).toBe(true);
  });

  it("derives bridge channel access from explicit mobile capability decisions", () => {
    expect(isMobileBridgeRequestChannel("agent:sendInput")).toBe(true);
    expect(isMobileBridgeRequestChannel("display:readFile")).toBe(true);
    expect(isMobileBridgeRequestChannel("officePreview:list")).toBe(true);
    expect(isMobileBridgeRequestChannel("officePreview:start")).toBe(true);
    expect(isMobileBridgeEventChannel("officePreview:update")).toBe(false);
    expect(isMobileBridgeRequestChannel("devtest:triggerViteError")).toBe(
      false,
    );
    expect(
      MOBILE_BRIDGE_REQUEST_CAPABILITIES.some(
        (capability) =>
          capability.path === "agent.sendInput" &&
          capability.channel === "agent:sendInput",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_EVENT_CAPABILITIES.some(
        (capability) =>
          capability.path === "agent.onStream" &&
          capability.channel === "agent:event",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.path === "system.openExternal" &&
          capability.mode === "native",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.path === "display.readFile" &&
          capability.mode === "remote-request" &&
          capability.channel === "display:readFile",
      ),
    ).toBe(true);
    expect(
      MOBILE_BRIDGE_CAPABILITIES.some(
        (capability) =>
          capability.path === "officePreview.onUpdate" &&
          capability.mode === "noop",
      ),
    ).toBe(true);
  });

  it("bootstraps welcome dialog state into the mobile WebView", () => {
    expect(
      buildMobileBridgeBootstrap({
        "stella-welcome-dialog-seen": "true",
        "stella:post-onboarding-hints":
          '{"seededAt":1,"active":{"connect":true}}',
        "stella.home.ideasSeen.v2.default": '{"Ideas":"abcd"}',
        "stella-billing-last-seen-plan:user@example.com": "pro",
        "stella-nickname:user@example.com": "Rahul",
        "stella-nickname-asked:user@example.com": "true",
        "stella-dictation-local": "true",
        "stella.displayPanel.width": "480",
        "better-auth_cookie": "secret",
        "stella-onboarding-complete": "true",
        "unrelated-key": "ignored",
      }),
    ).toMatchObject({
      localStorage: {
        "stella-welcome-dialog-seen": "true",
        "stella:post-onboarding-hints":
          '{"seededAt":1,"active":{"connect":true}}',
        "stella.home.ideasSeen.v2.default": '{"Ideas":"abcd"}',
        "stella-billing-last-seen-plan:user@example.com": "pro",
        "stella-nickname:user@example.com": "Rahul",
        "stella-nickname-asked:user@example.com": "true",
        "stella-dictation-local": "true",
        "stella-onboarding-complete": "true",
      },
      mobileBridgeCapabilities: {
        version: 1,
      },
    });
  });
});
