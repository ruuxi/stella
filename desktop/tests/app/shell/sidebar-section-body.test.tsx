// @vitest-environment jsdom

/**
 * The section id → body mapping, pinned.
 *
 * A section id that resolves to `undefined` is not a contained failure: this
 * component sits above the panel's error boundary, so React's invalid-element
 * error takes the shell down with it. Renaming a section is exactly when that
 * happens — the id set, the component files, and the persisted values all move
 * at different rates — and it typechecks the whole way, because the map is
 * only as exhaustive as the id union it was written against. So this asserts
 * against real ids at runtime, including the retired ones.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_SIDEBAR_SECTION_IDS,
  SIDEBAR_SECTIONS,
  sidebarSections,
} from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";

// The section bodies are the subject; their leaves are not. These three each
// pull a provider tree (chat runtime, router, user-app registry) that has
// nothing to do with whether a section resolves to a component.
vi.mock("@/shell/workspace/WorkspaceSections", () => ({
  WorkspaceSections: () => <div data-stub="workspace-sections" />,
}));
vi.mock("@/app/apps/PersistentUserAppsHost", () => ({
  PersistentUserAppsHost: () => <div data-stub="apps-host" />,
}));
vi.mock("@/app/chat/DropOverlay", () => ({
  DropOverlay: () => <div data-stub="drop-overlay" />,
}));

const { SidebarSectionBody, sidebarSectionBody } =
  await import("@/shell/sidebar-sections/SidebarSectionBody");

describe("sidebarSectionBody", () => {
  it("resolves every live section id to a component", () => {
    for (const section of SIDEBAR_SECTIONS) {
      expect(typeof sidebarSectionBody(section)).toBe("function");
    }
  });

  it("resolves every retired section id to a component", () => {
    // `tasks` and `search` can still be sitting in persisted state from a
    // build before the rename. They must land on Home, not on nothing.
    expect(LEGACY_SIDEBAR_SECTION_IDS.length).toBeGreaterThan(0);
    for (const section of LEGACY_SIDEBAR_SECTION_IDS) {
      expect(typeof sidebarSectionBody(section)).toBe("function");
    }
  });

  it("falls back to Home for an id from no build at all", () => {
    for (const section of ["", "Home", "notes", "__proto__", "toString"]) {
      expect(typeof sidebarSectionBody(section)).toBe("function");
    }
    expect(sidebarSectionBody("notes")).toBe(sidebarSectionBody("home"));
    expect(sidebarSectionBody("tasks")).toBe(sidebarSectionBody("home"));
    expect(sidebarSectionBody("search")).toBe(sidebarSectionBody("home"));
  });
});

describe("SidebarSectionBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    displayTabs.reset();
    sidebarSections.reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    displayTabs.reset();
    sidebarSections.reset();
  });

  const hostedSections = () =>
    [...container.querySelectorAll(".sidebar-section")].map((el) =>
      el.getAttribute("data-section"),
    );

  it("mounts one host per section without a render error", () => {
    act(() => root.render(<SidebarSectionBody />));
    expect(hostedSections()).toEqual([...SIDEBAR_SECTIONS]);
  });

  it("keeps every host mounted and marks only the active one", () => {
    act(() => root.render(<SidebarSectionBody />));
    act(() => sidebarSections.selectSection("apps"));

    expect(hostedSections()).toEqual([...SIDEBAR_SECTIONS]);
    const active = [...container.querySelectorAll(".sidebar-section")].filter(
      (el) => el.getAttribute("data-active") === "true",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("data-section")).toBe("apps");
  });

  it("renders Home when the store is holding a retired section id", () => {
    // The path a stale persisted value takes in: it typechecks at every hop,
    // so only a runtime assertion catches the body going missing.
    act(() => root.render(<SidebarSectionBody />));
    act(() => sidebarSections.setActiveSection("tasks" as unknown as "home"));

    expect(sidebarSections.getSnapshot().activeSection).toBe("home");
    expect(hostedSections()).toEqual([...SIDEBAR_SECTIONS]);
    const active = [...container.querySelectorAll(".sidebar-section")].filter(
      (el) => el.getAttribute("data-active") === "true",
    );
    expect(active[0]?.getAttribute("data-section")).toBe("home");
  });
});
