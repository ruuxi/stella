import { describe, expect, it } from "vitest";

import { isConnectRequestVisibleToSurface } from "../../../src/features/chat/connector-connect-scope.js";

describe("isConnectRequestVisibleToSurface", () => {
  it("shows unscoped requests on every surface", () => {
    expect(isConnectRequestVisibleToSurface({}, "conv-1")).toBe(true);
    expect(isConnectRequestVisibleToSurface({}, null)).toBe(true);
    expect(isConnectRequestVisibleToSurface({}, undefined)).toBe(true);
  });

  it("shows scoped requests only on the matching surface", () => {
    const scoped = { conversationId: "conv-1" };
    expect(isConnectRequestVisibleToSurface(scoped, "conv-1")).toBe(true);
    expect(isConnectRequestVisibleToSurface(scoped, "conv-2")).toBe(false);
  });

  it("never leaks scoped requests onto surfaces without a conversation id", () => {
    const scoped = { conversationId: "conv-1" };
    expect(isConnectRequestVisibleToSurface(scoped, null)).toBe(false);
    expect(isConnectRequestVisibleToSurface(scoped, undefined)).toBe(false);
  });
});
