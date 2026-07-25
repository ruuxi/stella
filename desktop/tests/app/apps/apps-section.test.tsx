// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn().mockResolvedValue(undefined),
}));

const userApp = vi.hoisted(() => ({
  slug: "ledger",
  meta: { label: "Ledger", createdAt: "2026-01-01T00:00:00.000Z" },
  load: () =>
    Promise.resolve({
      default: () => null,
      meta: { label: "Ledger", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
}));

// One stable array identity: `useSyncExternalStore` treats a fresh snapshot
// object on every read as a change and re-renders forever.
const registrySnapshot = vi.hoisted(() => [] as unknown[]);

vi.mock("@/app/_user/user-apps-registry", () => ({
  getSnapshot: () => registrySnapshot,
  subscribe: () => () => {},
  getUserApp: (slug: string) => (slug === userApp.slug ? userApp : undefined),
}));

registrySnapshot.push(userApp);

const { AppsSection } = await import("@/shell/sidebar-sections/AppsSection");
const { sidebarSections } = await import(
  "@/features/workspace-display/sidebar-sections"
);
const { displayTabs } = await import("@/features/workspace-display/tab-store");

describe("AppsSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sidebarSections.reset();
    displayTabs.setPanelOpen(true);
    sidebarSections.setActiveSection("apps");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sidebarSections.reset();
  });

  const render = () =>
    act(() => {
      root.render(<AppsSection />);
    });

  it("lists the library, opens an app in place, and comes back", () => {
    render();
    const card = container.querySelector<HTMLButtonElement>(
      ".apps-section__card",
    );
    expect(card?.textContent).toContain("Ledger");

    act(() => card!.click());
    expect(sidebarSections.getSnapshot().locations.apps).toBe("ledger");
    expect(container.querySelector(".apps-section__card")).toBeNull();
    expect(
      container.querySelector(".sidebar-section__viewer-title")?.textContent,
    ).toBe("Ledger");

    const back = container.querySelector<HTMLButtonElement>(
      ".sidebar-section__back",
    );
    act(() => back!.click());
    expect(sidebarSections.getSnapshot().locations.apps).toBeNull();
    expect(container.querySelector(".apps-section__card")).not.toBeNull();
  });

  // The whole reason the host is a fixed sibling of the library rather than a
  // child of the open-app branch: a surface that is moved or remounted loses
  // iframe browsing contexts, media state and scroll position.
  it("keeps the same surface element across a close and reopen", () => {
    render();
    act(() =>
      container.querySelector<HTMLButtonElement>(".apps-section__card")!.click(),
    );
    const surface = container.querySelector(".persistent-user-app-surface");
    expect(surface).not.toBeNull();

    act(() => displayTabs.setPanelOpen(false));
    act(() => sidebarSections.setActiveSection("files"));
    act(() => sidebarSections.selectSection("apps"));

    expect(container.querySelector(".persistent-user-app-surface")).toBe(
      surface,
    );
    expect(sidebarSections.getSnapshot().locations.apps).toBe("ledger");
  });
});
