import { describe, expect, it } from "vitest";
import {
  MOBILE_BRIDGE_EVENT_CHANNELS,
  MOBILE_BRIDGE_REQUEST_CHANNELS,
  isMobileBridgeEventChannel,
  isMobileBridgeRequestChannel,
} from "../../../../electron/services/mobile-bridge/bridge-policy.js";

describe("mobile bridge policy", () => {
  it("allows every declared mobile request channel", () => {
    for (const channel of MOBILE_BRIDGE_REQUEST_CHANNELS) {
      expect(isMobileBridgeRequestChannel(channel)).toBe(true);
    }
  });

  it("allows every declared mobile event channel", () => {
    for (const channel of MOBILE_BRIDGE_EVENT_CHANNELS) {
      expect(isMobileBridgeEventChannel(channel)).toBe(true);
    }
  });

  it("rejects channels that are not explicitly listed", () => {
    expect(isMobileBridgeRequestChannel("window:close")).toBe(false);
    expect(isMobileBridgeRequestChannel("browser:fetchJson")).toBe(false);
    expect(isMobileBridgeEventChannel("window:close")).toBe(false);
    expect(isMobileBridgeEventChannel("browser:fetchJson")).toBe(false);
  });
});
