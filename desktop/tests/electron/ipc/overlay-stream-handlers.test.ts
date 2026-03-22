import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcOnHandlers = new Map<string, (...args: unknown[]) => void>();
const receiverById = new Map<number, { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }>();
const fromId = vi.fn((id: number) => receiverById.get(id) ?? null);

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcOnHandlers.set(channel, handler);
    }),
  },
  webContents: {
    fromId,
  },
}));

const { registerOverlayStreamHandlers } = await import(
  "../../../electron/ipc/overlay-stream-handlers.js"
);

describe("registerOverlayStreamHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
    ipcOnHandlers.clear();
    receiverById.clear();
    fromId.mockClear();
  });

  it("forwards sidecar overlay stream events back to the invoking renderer", async () => {
    const send = vi.fn();
    receiverById.set(17, {
      isDestroyed: () => false,
      send,
    });

    let overlayListener: ((payload: {
      requestId: string;
      kind: "chunk" | "complete" | "error";
      chunk?: string;
      text?: string;
      error?: string;
    }) => void) | null = null;
    const startOverlayAutoPanelStream = vi.fn(async () => ({ ok: true }));

    registerOverlayStreamHandlers({
      getStellaHostRunner: () =>
        ({
          getAvailabilitySnapshot: () => ({
            connected: true,
            ready: true,
          }),
          onAvailabilityChange: vi.fn(() => () => {}),
          onOverlayAutoPanelEvent: vi.fn((listener) => {
            overlayListener = listener;
            return () => {
              overlayListener = null;
            };
          }),
          startOverlayAutoPanelStream,
          cancelOverlayAutoPanelStream: vi.fn(async () => ({ ok: true })),
        }) as never,
      assertPrivilegedSender: () => true,
    });

    const startHandler = ipcHandleHandlers.get("overlay:autoPanelStart");
    await expect(
      startHandler?.(
        {
          sender: { id: 17 },
        },
        {
          requestId: "req-1",
          agentType: "auto",
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(startOverlayAutoPanelStream).toHaveBeenCalledTimes(1);
    const runtimeRequestId = startOverlayAutoPanelStream.mock.calls[0]?.[0]?.requestId;
    expect(runtimeRequestId).toContain("17:req-1");

    overlayListener?.({
      requestId: runtimeRequestId,
      kind: "chunk",
      chunk: "Hello",
    });
    overlayListener?.({
      requestId: runtimeRequestId,
      kind: "complete",
      text: "Hello there",
    });

    expect(send).toHaveBeenNthCalledWith(1, "overlay:autoPanelChunk", {
      requestId: "req-1",
      chunk: "Hello",
    });
    expect(send).toHaveBeenNthCalledWith(2, "overlay:autoPanelComplete", {
      requestId: "req-1",
      text: "Hello there",
    });
  });
});
