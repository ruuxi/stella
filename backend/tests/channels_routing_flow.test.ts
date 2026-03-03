import { describe, test, expect } from "bun:test";
import {
  shouldBlockInboundByDmPolicy,
  CONNECTED_MODE_REQUIRED_ERROR,
  ACCOUNT_MODE_CONNECTED,
  type DmPolicyConfig,
} from "../convex/channels/routing_flow";

describe("shouldBlockInboundByDmPolicy", () => {
  const openPolicy: DmPolicyConfig = {
    policy: "open",
    allowlist: [],
    denylist: [],
  };

  const pairingPolicy: DmPolicyConfig = {
    policy: "pairing",
    allowlist: [],
    denylist: [],
  };

  const allowlistPolicy: DmPolicyConfig = {
    policy: "allowlist",
    allowlist: ["user-1", "user-2"],
    denylist: [],
  };

  const disabledPolicy: DmPolicyConfig = {
    policy: "disabled",
    allowlist: [],
    denylist: [],
  };

  test("open policy allows all users", () => {
    expect(
      shouldBlockInboundByDmPolicy({
        policy: openPolicy,
        externalUserId: "anyone",
        hasExistingConnection: false,
      }),
    ).toBe(false);
  });

  test("disabled policy blocks all users", () => {
    expect(
      shouldBlockInboundByDmPolicy({
        policy: disabledPolicy,
        externalUserId: "anyone",
        hasExistingConnection: true,
      }),
    ).toBe(true);
  });

  test("pairing policy blocks without existing connection", () => {
    expect(
      shouldBlockInboundByDmPolicy({
        policy: pairingPolicy,
        externalUserId: "user-1",
        hasExistingConnection: false,
      }),
    ).toBe(true);
  });

  test("pairing policy allows with existing connection", () => {
    expect(
      shouldBlockInboundByDmPolicy({
        policy: pairingPolicy,
        externalUserId: "user-1",
        hasExistingConnection: true,
      }),
    ).toBe(false);
  });

  test("allowlist policy allows listed users", () => {
    expect(
      shouldBlockInboundByDmPolicy({
        policy: allowlistPolicy,
        externalUserId: "user-1",
        hasExistingConnection: false,
      }),
    ).toBe(false);
  });

  test("allowlist policy blocks unlisted users", () => {
    expect(
      shouldBlockInboundByDmPolicy({
        policy: allowlistPolicy,
        externalUserId: "user-3",
        hasExistingConnection: false,
      }),
    ).toBe(true);
  });

  test("denylist overrides all policies", () => {
    const policyWithDenylist: DmPolicyConfig = {
      policy: "open",
      allowlist: [],
      denylist: ["blocked-user"],
    };
    expect(
      shouldBlockInboundByDmPolicy({
        policy: policyWithDenylist,
        externalUserId: "blocked-user",
        hasExistingConnection: true,
      }),
    ).toBe(true);
  });
});

describe("constants", () => {
  test("ACCOUNT_MODE_CONNECTED is 'connected'", () => {
    expect(ACCOUNT_MODE_CONNECTED).toBe("connected");
  });

  test("CONNECTED_MODE_REQUIRED_ERROR is defined", () => {
    expect(CONNECTED_MODE_REQUIRED_ERROR).toContain("Connected mode");
  });
});
