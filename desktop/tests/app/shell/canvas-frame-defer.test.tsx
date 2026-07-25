// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  panelOpen: true,
  fileReads: vi.fn(() => ({ bytes: null, error: null, loading: true })),
}));

vi.mock("@/features/workspace-display/tab-store", () => ({
  useDisplayPanelOpen: () => probe.panelOpen,
}));

vi.mock("@/shared/hooks/use-display-file-data", () => ({
  useDisplayFileBytes: probe.fileReads,
}));

vi.mock("@/shell/display/canvas-tab/CanvasShareBar", () => ({
  CanvasShareBar: () => null,
}));

vi.mock("@/shell/display/illustrations/CanvasIllustration", () => ({
  CanvasIllustration: () => <span data-testid="canvas-illustration" />,
}));

import { CanvasTabContent } from "@/shell/display/canvas-tab/CanvasTabContent";
import {
  addCanvasHtmlItem,
  type CanvasHtmlItem,
} from "@/shell/display/canvas-tab/canvas-items";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Canvas iframe startup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  let item: CanvasHtmlItem;

  beforeEach(() => {
    probe.panelOpen = true;
    probe.fileReads.mockClear();
    frames = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        frames.push(callback);
        return frames.length;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const path = `/tmp/canvas-frame-defer-${crypto.randomUUID()}.html`;
    const items = addCanvasHtmlItem({
      kind: "canvas-html",
      filePath: path,
      title: "Deferred canvas",
      createdAt: 1,
    });
    item = items.find((candidate) => candidate.filePath === path)!;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderCanvas = async (current: CanvasHtmlItem) => {
    await act(async () => {
      root.render(<CanvasTabContent item={current} />);
    });
  };

  const runNextFrame = async () => {
    const callback = frames.shift();
    expect(callback).toBeTypeOf("function");
    await act(async () => callback!(performance.now()));
  };

  it("paints loading before starting a file read, including a kept-alive refresh", async () => {
    await renderCanvas(item);

    expect(container.textContent).toContain("Loading");
    expect(probe.fileReads).not.toHaveBeenCalled();

    await runNextFrame();
    expect(probe.fileReads).not.toHaveBeenCalled();
    await runNextFrame();
    expect(probe.fileReads).toHaveBeenCalledTimes(1);

    probe.panelOpen = false;
    await renderCanvas(item);
    const readsBeforeRefresh = probe.fileReads.mock.calls.length;

    // Model clicking an overwritten artifact while the old iframe is still
    // mounted in the closed panel's keep-alive host. The version change must
    // synchronously replace it with loading, not begin another file read.
    await act(async () => {
      const refreshed = addCanvasHtmlItem({
        kind: "canvas-html",
        filePath: item.filePath,
        title: item.title,
        createdAt: 2,
      }).find((candidate) => candidate.filePath === item.filePath)!;
      probe.panelOpen = true;
      root.render(<CanvasTabContent item={refreshed} />);
    });

    expect(container.textContent).toContain("Loading");
    expect(probe.fileReads).toHaveBeenCalledTimes(readsBeforeRefresh);
    await runNextFrame();
    expect(probe.fileReads).toHaveBeenCalledTimes(readsBeforeRefresh);
    await runNextFrame();
    expect(probe.fileReads).toHaveBeenCalledTimes(readsBeforeRefresh + 1);
  });
});
