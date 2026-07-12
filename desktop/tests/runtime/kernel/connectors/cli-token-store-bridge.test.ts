import path from "node:path";
import { stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  requestConnectorTokenStoreFromBridge,
  requestStellaSiteAuthFromBridge,
} from "../../../../../runtime/kernel/connectors/cli-broker-client.js";
import { startCliBridgeServer } from "../../../../../runtime/worker/cli-bridge-server.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();
const servers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  tempDirs.cleanup();
});

describe("stella-connect token-store bridge", () => {
  it("round-trips token loads, saves, and deletes over the owner-only socket", async () => {
    const root = tempDirs.create("stella-connect-token-bridge-");
    const socketPath = path.join(root, "bridge.sock");
    const requests: unknown[] = [];
    const server = await startCliBridgeServer({
      socketPath,
      handlers: {
        requestConnectorCredential: async () => ({ ok: true }),
        requestConnectorTokenStore: async (request) => {
          requests.push(request);
          if (request.operation === "load") {
            return {
              ok: true,
              payload: {
                accessToken: "outlook-access",
                refreshToken: "outlook-refresh",
              },
            };
          }
          return { ok: true };
        },
      },
    });
    servers.push(server);

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    await expect(
      requestConnectorTokenStoreFromBridge({
        socketPath,
        request: { operation: "load", tokenKey: "native-oauth:microsoft" },
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        accessToken: "outlook-access",
        refreshToken: "outlook-refresh",
      },
    });
    await requestConnectorTokenStoreFromBridge({
      socketPath,
      request: {
        operation: "save",
        tokenKey: "native-oauth:microsoft",
        payload: { accessToken: "refreshed" },
      },
    });
    await requestConnectorTokenStoreFromBridge({
      socketPath,
      request: {
        operation: "delete",
        tokenKeys: ["native-oauth:microsoft"],
      },
    });

    expect(requests).toEqual([
      { operation: "load", tokenKey: "native-oauth:microsoft" },
      {
        operation: "save",
        tokenKey: "native-oauth:microsoft",
        payload: { accessToken: "refreshed" },
      },
      { operation: "delete", tokenKeys: ["native-oauth:microsoft"] },
    ]);
  });

  it("requests a fresh Stella session without putting it in process arguments", async () => {
    const root = tempDirs.create("stella-site-auth-bridge-");
    const socketPath = path.join(root, "bridge.sock");
    const refreshRequests: boolean[] = [];
    const server = await startCliBridgeServer({
      socketPath,
      handlers: {
        requestConnectorCredential: async () => ({ ok: true }),
        getStellaSiteAuth: async ({ refresh }) => {
          refreshRequests.push(refresh);
          return {
            ok: true,
            baseUrl: "https://stella.test",
            authToken: "synthetic-session-token",
          };
        },
      },
    });
    servers.push(server);

    await expect(
      requestStellaSiteAuthFromBridge({ socketPath, refresh: true }),
    ).resolves.toEqual({
      ok: true,
      baseUrl: "https://stella.test",
      authToken: "synthetic-session-token",
    });
    expect(refreshRequests).toEqual([true]);
  });
});
