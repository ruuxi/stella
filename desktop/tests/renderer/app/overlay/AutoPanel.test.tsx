import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoPanel } from "../../../../src/shell/overlay/AutoPanel";

vi.mock("../../../../src/app/chat/Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

describe("AutoPanel", () => {
  let chunkCallback: ((data: { requestId: string; chunk: string }) => void) | null;
  let completeCallback: ((data: { requestId: string; text: string }) => void) | null;
  let errorCallback: ((data: { requestId: string; error: string }) => void) | null;

  beforeEach(() => {
    chunkCallback = null;
    completeCallback = null;
    errorCallback = null;

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      overlay: {
        startAutoPanelStream: vi.fn().mockResolvedValue({ ok: true }),
        cancelAutoPanelStream: vi.fn(),
        onAutoPanelChunk: vi.fn((callback: typeof chunkCallback) => {
          chunkCallback = callback;
          return vi.fn();
        }),
        onAutoPanelComplete: vi.fn((callback: typeof completeCallback) => {
          completeCallback = callback;
          return vi.fn();
        }),
        onAutoPanelError: vi.fn((callback: typeof errorCallback) => {
          errorCallback = callback;
          return vi.fn();
        }),
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  it("streams auto panel responses through the overlay IPC bridge", () => {
    render(
      <AutoPanel
        windowText="Draft a reply"
        windowTitle="Mail"
        onClose={vi.fn()}
      />,
    );

    expect(window.electronAPI?.overlay.startAutoPanelStream).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "auto-panel-1",
        agentType: "auto",
      }),
    );

    act(() => {
      chunkCallback?.({ requestId: "auto-panel-1", chunk: "Sounds good." });
    });

    expect(screen.getByText("Sounds good.")).toBeInTheDocument();

    act(() => {
      completeCallback?.({ requestId: "auto-panel-1", text: "Sounds good." });
    });

    expect(screen.getByText("Sounds good.")).toBeInTheDocument();
  });
});


