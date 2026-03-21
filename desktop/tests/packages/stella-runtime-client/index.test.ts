import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METHOD_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
} from "../../../packages/stella-runtime-protocol/src/index.js";

type MockChild = EventEmitter & {
  pid: number;
  stdin: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

type MockPeer = {
  request: ReturnType<typeof vi.fn>;
  registerRequestHandler: ReturnType<typeof vi.fn>;
  registerNotificationHandler: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  requestHandlers: Map<string, (params: unknown) => Promise<unknown> | unknown>;
  notificationHandlers: Map<string, (params: unknown) => void>;
};

const spawnedChildren: MockChild[] = [];
const peers: MockPeer[] = [];

const createMockChild = (pid: number): MockChild => {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.emit("exit", 0);
    return true;
  });
  return child;
};

const spawnMock = vi.fn(() => {
  const child = createMockChild(spawnedChildren.length + 100);
  spawnedChildren.push(child);
  return child;
});

const attachJsonRpcPeerToStreamsMock = vi.fn(() => {
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const peer: MockPeer = {
    request: vi.fn(async (method: string) => {
      switch (method) {
        case METHOD_NAMES.INITIALIZE:
          return {
            protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
            daemonPid: 200,
          };
        case METHOD_NAMES.INITIALIZED:
          return { ok: true };
        case METHOD_NAMES.RUNTIME_HEALTH:
          return {
            ready: true,
            daemonPid: 200,
            workerPid: 201,
            workerGeneration: 1,
            deviceId: "device-1",
            activeRunId: null,
            activeTaskCount: 0,
          };
        default:
          return { ok: true };
      }
    }),
    registerRequestHandler: vi.fn((method, handler) => {
      requestHandlers.set(method, handler);
    }),
    registerNotificationHandler: vi.fn((method, handler) => {
      notificationHandlers.set(method, handler);
    }),
    notify: vi.fn(),
    requestHandlers,
    notificationHandlers,
  };
  peers.push(peer);
  return { peer };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../../../packages/stella-runtime-protocol/src/jsonl.js", () => ({
  attachJsonRpcPeerToStreams: attachJsonRpcPeerToStreamsMock,
}));

const { StellaRuntimeClient } = await import(
  "../../../packages/stella-runtime-client/src/index.js"
);

describe("StellaRuntimeClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnedChildren.length = 0;
    peers.length = 0;
    spawnMock.mockClear();
    attachJsonRpcPeerToStreamsMock.mockClear();
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("backs off daemon respawns after repeated crashes", async () => {
    const client = new StellaRuntimeClient({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: false,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    await client.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnedChildren[0]?.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(249);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    spawnedChildren[1]?.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(499);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    await client.stop();
  });

  it("extracts html from host display update payload objects", async () => {
    const displayUpdate = vi.fn(async () => {});
    const client = new StellaRuntimeClient({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: false,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity: async () => ({
          deviceId: "device-1",
          publicKey: "public-key",
        }),
        signHeartbeatPayload: async () => ({
          publicKey: "public-key",
          signature: "signature",
        }),
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate,
      },
    });

    await client.start();

    const handler = peers[0]?.requestHandlers.get(METHOD_NAMES.HOST_DISPLAY_UPDATE);
    expect(handler).toBeTypeOf("function");

    await handler?.({ html: "<section>Hello</section>" });

    expect(displayUpdate).toHaveBeenCalledWith("<section>Hello</section>");

    await client.stop();
  });

  it("forwards host device identity and heartbeat signing requests", async () => {
    const getDeviceIdentity = vi.fn(async () => ({
      deviceId: "device-1",
      publicKey: "public-key",
    }));
    const signHeartbeatPayload = vi.fn(async () => ({
      publicKey: "public-key",
      signature: "sig-123",
    }));
    const client = new StellaRuntimeClient({
      initializeParams: {
        clientName: "test",
        clientVersion: "0.0.0",
        isDev: false,
        platform: "win32",
        frontendRoot: "/mock/frontend",
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
      },
      hostHandlers: {
        uiSnapshot: async () => "",
        uiAct: async () => "",
        getDeviceIdentity,
        signHeartbeatPayload,
        requestCredential: async () => ({
          secretId: "secret",
          provider: "provider",
          label: "label",
        }),
        displayUpdate: async () => {},
      },
    });

    await client.start();

    const identityHandler = peers[0]?.requestHandlers.get(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
    );
    const signHandler = peers[0]?.requestHandlers.get(
      METHOD_NAMES.HOST_DEVICE_HEARTBEAT_SIGN,
    );

    await expect(identityHandler?.({})).resolves.toEqual({
      deviceId: "device-1",
      publicKey: "public-key",
    });
    await expect(signHandler?.({ signedAtMs: 1234 })).resolves.toEqual({
      publicKey: "public-key",
      signature: "sig-123",
    });
    expect(getDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(signHeartbeatPayload).toHaveBeenCalledWith(1234);

    await client.stop();
  });
});
