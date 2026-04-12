import { describe, expect, it, vi } from "vitest";
import { createConvexSession } from "../../../../runtime/kernel/runner/convex-session.js";

const CONVEX_URL = "https://example.convex.cloud";

const createFakeClient = () => ({
  close: vi.fn().mockResolvedValue(undefined),
  setAuth: vi.fn(),
});

const createContext = (client = createFakeClient()) =>
  ({
    state: {
      convexClient: client,
      convexClientUrl: CONVEX_URL,
      convexDeploymentUrl: CONVEX_URL,
      convexSiteUrl: null,
      authToken: "old-token",
      cloudSyncEnabled: false,
      hasConnectedAccount: true,
    },
  }) as any;

describe("createConvexSession", () => {
  it("recreates the Convex client when the auth token changes", async () => {
    const client = createFakeClient();
    const context = createContext(client);
    const syncRemoteTurnBridge = vi.fn();
    const onAuthTokenSet = vi.fn();
    const session = createConvexSession(context, {
      syncRemoteTurnBridge,
      onAuthTokenSet,
    });

    session.setAuthToken("new-token");
    await Promise.resolve();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(context.state.convexClient).toBeNull();
    expect(context.state.convexClientUrl).toBeNull();
    expect(context.state.authToken).toBe("new-token");
    expect(syncRemoteTurnBridge).toHaveBeenCalledTimes(1);
    expect(onAuthTokenSet).toHaveBeenCalledTimes(1);
  });

  it("leaves the Convex client alone when the auth token is unchanged", () => {
    const client = createFakeClient();
    const context = createContext(client);
    const syncRemoteTurnBridge = vi.fn();
    const onAuthTokenSet = vi.fn();
    const session = createConvexSession(context, {
      syncRemoteTurnBridge,
      onAuthTokenSet,
    });

    session.setAuthToken("old-token");

    expect(client.close).not.toHaveBeenCalled();
    expect(syncRemoteTurnBridge).not.toHaveBeenCalled();
    expect(onAuthTokenSet).not.toHaveBeenCalled();
  });

  it("reconnects when the same auth token is force-reapplied", async () => {
    const client = createFakeClient();
    const context = createContext(client);
    const syncRemoteTurnBridge = vi.fn();
    const onAuthTokenSet = vi.fn();
    const session = createConvexSession(context, {
      syncRemoteTurnBridge,
      onAuthTokenSet,
    });

    session.setAuthToken("old-token", { forceReconnect: true });
    await Promise.resolve();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(context.state.convexClient).toBeNull();
    expect(context.state.convexClientUrl).toBeNull();
    expect(context.state.authToken).toBe("old-token");
    expect(syncRemoteTurnBridge).toHaveBeenCalledTimes(1);
    expect(onAuthTokenSet).toHaveBeenCalledTimes(1);
  });
});
