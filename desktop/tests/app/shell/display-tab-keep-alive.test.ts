import { describe, expect, it } from "vitest";
import { resolveDisplayTabKeepAlive } from "@/features/workspace-display/display-tab-keep-alive";
import type { DisplayTabSpec } from "@/features/workspace-display/types";

const tab = (id: string, kind: DisplayTabSpec["kind"]): DisplayTabSpec => ({
  id,
  kind,
  title: id,
  render: () => null,
});

const canvasTab = tab("canvas:html", "canvas");
const mediaTab = tab("media:generated", "media");

describe("resolveDisplayTabKeepAlive", () => {
  it("renders the active tab while the panel is open and records it", () => {
    const result = resolveDisplayTabKeepAlive({
      panelOpen: true,
      activeTab: canvasTab,
      lastRenderedTabId: null,
    });
    expect(result.renderedTab).toBe(canvasTab);
    expect(result.lastRenderedTabId).toBe("canvas:html");
  });

  it("keeps a just-viewed canvas mounted across close → open", () => {
    // Open with the canvas showing.
    const open = resolveDisplayTabKeepAlive({
      panelOpen: true,
      activeTab: canvasTab,
      lastRenderedTabId: null,
    });
    // Close: the same tab stays rendered (hidden host) — the iframe's
    // browsing context survives instead of being destroyed.
    const closed = resolveDisplayTabKeepAlive({
      panelOpen: false,
      activeTab: canvasTab,
      lastRenderedTabId: open.lastRenderedTabId,
    });
    expect(closed.renderedTab).toBe(canvasTab);
    expect(closed.lastRenderedTabId).toBe("canvas:html");
    // Reopen: same tab id → React reconciles in place, no remount.
    const reopened = resolveDisplayTabKeepAlive({
      panelOpen: true,
      activeTab: canvasTab,
      lastRenderedTabId: closed.lastRenderedTabId,
    });
    expect(reopened.renderedTab).toBe(canvasTab);
    expect(reopened.lastRenderedTabId).toBe("canvas:html");
  });

  it("does not keep non-canvas tabs alive on close (media must stop)", () => {
    const closed = resolveDisplayTabKeepAlive({
      panelOpen: false,
      activeTab: mediaTab,
      lastRenderedTabId: "media:generated",
    });
    expect(closed.renderedTab).toBeNull();
    expect(closed.lastRenderedTabId).toBeNull();
  });

  it("drops the kept canvas when the active tab changes while closed", () => {
    const closed = resolveDisplayTabKeepAlive({
      panelOpen: false,
      activeTab: mediaTab,
      lastRenderedTabId: "canvas:html",
    });
    expect(closed.renderedTab).toBeNull();
    expect(closed.lastRenderedTabId).toBeNull();
  });

  it("never pre-renders a canvas that was not shown before the close", () => {
    // Panel has been closed the whole time (e.g. payload activated a canvas
    // tab without opening the panel — the no-auto-open flow).
    const closed = resolveDisplayTabKeepAlive({
      panelOpen: false,
      activeTab: canvasTab,
      lastRenderedTabId: null,
    });
    expect(closed.renderedTab).toBeNull();
    expect(closed.lastRenderedTabId).toBeNull();
  });

  it("clears tracking when the panel is open with no active tab", () => {
    const result = resolveDisplayTabKeepAlive({
      panelOpen: true,
      activeTab: null,
      lastRenderedTabId: "canvas:html",
    });
    expect(result.renderedTab).toBeNull();
    expect(result.lastRenderedTabId).toBeNull();
  });
});
