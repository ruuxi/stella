import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing module under test
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./convex-client", () => ({
  convexClient: {
    mutation: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/convex/api", () => ({
  api: {
    auth: {
      revokeActiveSessions: "auth:revokeActiveSessions",
    },
  },
}));

import { secureSignOut, secureSignOutAllDevices } from "./auth";
import { authClient } from "@/lib/auth-client";
import { convexClient } from "./convex-client";

describe("secureSignOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls signOut without revoking sessions for current_device scope", async () => {
    await secureSignOut("current_device");
    expect(convexClient.mutation).not.toHaveBeenCalled();
    expect(authClient.signOut).toHaveBeenCalled();
  });

  it("defaults to current_device scope", async () => {
    await secureSignOut();
    expect(convexClient.mutation).not.toHaveBeenCalled();
    expect(authClient.signOut).toHaveBeenCalled();
  });

  it("revokes sessions then signs out for all_devices scope", async () => {
    await secureSignOut("all_devices");
    expect(convexClient.mutation).toHaveBeenCalledWith("auth:revokeActiveSessions", {});
    expect(authClient.signOut).toHaveBeenCalled();
  });

  it("still signs out even if session revocation fails", async () => {
    vi.mocked(convexClient.mutation).mockRejectedValueOnce(new Error("revoke failed"));
    await secureSignOut("all_devices");
    expect(authClient.signOut).toHaveBeenCalled();
  });
});

describe("secureSignOutAllDevices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to secureSignOut with all_devices", async () => {
    await secureSignOutAllDevices();
    expect(convexClient.mutation).toHaveBeenCalled();
    expect(authClient.signOut).toHaveBeenCalled();
  });
});
