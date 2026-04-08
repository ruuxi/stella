import { describe, expect, it, vi } from "vitest";
import { RuntimeClientAdapter } from "../../electron/runtime-client-adapter.js";

const createAdapter = () =>
  new RuntimeClientAdapter({
    hostHandlers: {
      uiSnapshot: async () => "",
      uiAct: async () => "",
      getDeviceIdentity: async () => ({ deviceId: "dev-device", publicKey: "pub" }),
      signHeartbeatPayload: async () => ({ publicKey: "pub", signature: "sig" }),
      requestCredential: async () => ({
        secretId: "secret",
        provider: "test",
        label: "Test",
      }),
      displayUpdate: () => undefined,
    },
    initializeParams: {
      clientName: "test-client",
      clientVersion: "0.0.0",
      isDev: false,
      platform: process.platform,
      frontendRoot: "/tmp/stella-test",
      stellaHomePath: "/tmp/stella-test",
      stellaWorkspacePath: "/tmp/stella-test",
    },
  });

describe("RuntimeClientAdapter config batching", () => {
  it("batches same-tick auth patches into one configure call", async () => {
    const adapter = createAdapter();
    const anyAdapter = adapter as any;
    anyAdapter.started = true;
    const configure = vi.fn().mockResolvedValue({ ok: true });
    anyAdapter.client.configure = configure;

    adapter.setHasConnectedAccount(true);
    adapter.setAuthToken("fresh-token");

    await Promise.resolve();

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith({
      hasConnectedAccount: true,
      authToken: "fresh-token",
    });
  });
});
