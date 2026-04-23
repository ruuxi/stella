import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayTabs } from "../../../src/shell/display/tab-store";
import type { DisplayTabSpec } from "../../../src/shell/display/types";

const makeSpec = (
  id: string,
  overrides: Partial<DisplayTabSpec> = {},
): DisplayTabSpec => ({
  id,
  kind: overrides.kind ?? "image",
  title: overrides.title ?? id,
  render: overrides.render ?? (() => null),
  ...(overrides.tooltip !== undefined ? { tooltip: overrides.tooltip } : {}),
  ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
});

beforeEach(() => {
  displayTabs.reset();
});

afterEach(() => {
  displayTabs.reset();
});

describe("displayTabs.openTab", () => {
  it("registers a new tab, activates it, and opens the panel", () => {
    displayTabs.openTab(makeSpec("media:image:/a.png"));
    const snap = displayTabs.getSnapshot();
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0]?.id).toBe("media:image:/a.png");
    expect(snap.activeTabId).toBe("media:image:/a.png");
    expect(snap.panelOpen).toBe(true);
  });

  it("dedupes by id: re-opening replaces the spec without stacking", () => {
    displayTabs.openTab(makeSpec("pdf:/a.pdf", { title: "v1" }));
    displayTabs.openTab(makeSpec("pdf:/a.pdf", { title: "v2" }));
    const snap = displayTabs.getSnapshot();
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0]?.title).toBe("v2");
  });

  it("preserves insertion order on dedup", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    displayTabs.openTab(makeSpec("a", { title: "a-v2" }));
    const ids = displayTabs.getSnapshot().tabs.map((t) => t.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("activate=false keeps the existing active tab and does not open the panel", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"), { activate: false });
    const snap = displayTabs.getSnapshot();
    expect(snap.activeTabId).toBe("a");
    expect(snap.panelOpen).toBe(true);
    expect(snap.tabs.map((t) => t.id)).toEqual(["a", "b"]);

    // Closing then re-registering passively should not pop the panel back open.
    displayTabs.setPanelOpen(false);
    displayTabs.openTab(makeSpec("c"), { activate: false });
    expect(displayTabs.getSnapshot().panelOpen).toBe(false);
    expect(displayTabs.getSnapshot().activeTabId).toBe("a");
  });

  it("can activate the refreshed tab without reopening the panel", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    displayTabs.setPanelOpen(false);

    displayTabs.openTab(makeSpec("a", { title: "a-updated" }), {
      activate: true,
      openPanel: false,
    });

    const snap = displayTabs.getSnapshot();
    expect(snap.activeTabId).toBe("a");
    expect(snap.panelOpen).toBe(false);
    expect(snap.tabs[0]?.title).toBe("a-updated");
  });
});

describe("displayTabs.activateTab / closeTab", () => {
  it("activates an existing tab and re-opens the panel", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    displayTabs.setPanelOpen(false);
    displayTabs.activateTab("a");
    const snap = displayTabs.getSnapshot();
    expect(snap.activeTabId).toBe("a");
    expect(snap.panelOpen).toBe(true);
  });

  it("activateTab is a no-op for unknown ids", () => {
    displayTabs.openTab(makeSpec("a"));
    const before = displayTabs.getSnapshot();
    displayTabs.activateTab("does-not-exist");
    expect(displayTabs.getSnapshot()).toBe(before);
  });

  it("closing the active tab activates a neighbour", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    displayTabs.openTab(makeSpec("c"));
    displayTabs.activateTab("b");
    displayTabs.closeTab("b");
    const snap = displayTabs.getSnapshot();
    expect(snap.tabs.map((t) => t.id)).toEqual(["a", "c"]);
    // Activates the tab that was previously to the left.
    expect(snap.activeTabId).toBe("a");
  });

  it("closing the last tab closes the panel", () => {
    displayTabs.openTab(makeSpec("only"));
    displayTabs.closeTab("only");
    const snap = displayTabs.getSnapshot();
    expect(snap.tabs).toHaveLength(0);
    expect(snap.activeTabId).toBeNull();
    expect(snap.panelOpen).toBe(false);
  });

  it("closing a non-active tab keeps the active tab and panel state", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    displayTabs.activateTab("a");
    displayTabs.closeTab("b");
    const snap = displayTabs.getSnapshot();
    expect(snap.activeTabId).toBe("a");
    expect(snap.panelOpen).toBe(true);
  });
});

describe("displayTabs.setPanelOpen / reorderTab / reset", () => {
  it("setPanelOpen is idempotent", () => {
    displayTabs.openTab(makeSpec("a"));
    const listener = vi.fn();
    const unsubscribe = displayTabs.subscribe(listener);
    displayTabs.setPanelOpen(true);
    expect(listener).not.toHaveBeenCalled();
    displayTabs.setPanelOpen(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("reorderTab moves a tab to the target index", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    displayTabs.openTab(makeSpec("c"));
    displayTabs.reorderTab("a", 2);
    expect(displayTabs.getSnapshot().tabs.map((t) => t.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("reset wipes everything", () => {
    displayTabs.openTab(makeSpec("a"));
    displayTabs.reset();
    const snap = displayTabs.getSnapshot();
    expect(snap.tabs).toHaveLength(0);
    expect(snap.activeTabId).toBeNull();
    expect(snap.panelOpen).toBe(false);
  });
});

describe("displayTabs.subscribe", () => {
  it("notifies on store mutations and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = displayTabs.subscribe(listener);
    displayTabs.openTab(makeSpec("a"));
    displayTabs.openTab(makeSpec("b"));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    displayTabs.openTab(makeSpec("c"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
