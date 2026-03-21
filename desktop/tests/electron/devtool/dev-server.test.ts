import { beforeEach, describe, expect, it, vi } from "vitest";

const clearStorageDataMock = vi.fn(async () => {});
const clearCacheMock = vi.fn(async () => {});
const fromPartitionMock = vi.fn(() => ({
  clearStorageData: clearStorageDataMock,
  clearCache: clearCacheMock,
}));
const exitMock = vi.fn();
const rmMock = vi.fn(async () => {});

vi.mock("electron", () => ({
  app: {
    exit: exitMock,
  },
  session: {
    fromPartition: fromPartitionMock,
  },
}));

vi.mock("fs", () => ({
  promises: {
    rm: rmMock,
  },
}));

const { DevToolServer } = await import("../../../electron/devtool/dev-server.js");

describe("DevToolServer", () => {
  beforeEach(() => {
    clearStorageDataMock.mockClear();
    clearCacheMock.mockClear();
    fromPartitionMock.mockClear();
    exitMock.mockClear();
    rmMock.mockClear();
  });

  it("awaits runtime shutdown before clearing local state during hard reset", async () => {
    let resolveShutdown: (() => void) | null = null;
    const shutdownRuntime = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const server = new DevToolServer({
      stellaHomePath: () => "/mock/home/.stella",
      sessionPartition: "persist:Stella",
      shutdownRuntime,
      onReloadApp: vi.fn(),
    });
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    const result = (server as any).handleCommand(ws, { command: "hard-reset" });

    await Promise.resolve();

    expect(shutdownRuntime).toHaveBeenCalledTimes(1);
    expect(clearStorageDataMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();

    resolveShutdown?.();
    await result;

    expect(clearStorageDataMock).toHaveBeenCalledTimes(1);
    expect(clearCacheMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith("/mock/home/.stella", {
      recursive: true,
      force: true,
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });
});
