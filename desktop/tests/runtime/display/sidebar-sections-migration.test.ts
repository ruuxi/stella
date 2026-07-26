// @vitest-environment jsdom

/**
 * The pre-rename → post-rename read path, exercised at module init.
 *
 * `readPersistedSection` and `readPersistedLocations` run exactly once, when
 * the store module is first evaluated, and both bail out early when there is
 * no `window`. That makes them invisible to the node-environment suite next
 * door: a migration assertion there passes without the migration ever running.
 * So this file is jsdom, seeds `window.__stellaUiState` the way the preload
 * does before any app code runs, and re-imports the store per case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECTION_KEY = "stella.sidebar.activeSection";
const LOCATIONS_KEY = "stella.sidebar.sectionLocations";

type StoreModule =
  typeof import("@/features/workspace-display/sidebar-sections");
type UiStateModule = typeof import("@/platform/ui-state");

/** Boot a fresh store module over a seeded persisted snapshot. */
const bootWith = async (
  seed: Record<string, string>,
): Promise<{ store: StoreModule; uiState: UiStateModule["uiState"] }> => {
  vi.resetModules();
  window.__stellaUiState = seed;
  const { uiState } = await import("@/platform/ui-state");
  const store: StoreModule =
    await import("@/features/workspace-display/sidebar-sections");
  return { store, uiState };
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  delete window.__stellaUiState;
  vi.resetModules();
});

describe("persisted active section", () => {
  it("boots a pre-rename `tasks` into home", async () => {
    const { store } = await bootWith({ [SECTION_KEY]: "tasks" });
    expect(store.sidebarSections.getSnapshot().activeSection).toBe("home");
  });

  it("boots a pre-rename `search` into home", async () => {
    const { store } = await bootWith({ [SECTION_KEY]: "search" });
    expect(store.sidebarSections.getSnapshot().activeSection).toBe("home");
  });

  it("boots an unrecognizable id into home", async () => {
    const { store } = await bootWith({ [SECTION_KEY]: "notes" });
    expect(store.sidebarSections.getSnapshot().activeSection).toBe("home");
  });

  it("rewrites the retired id so it does not outlive this launch", async () => {
    const { store, uiState } = await bootWith({ [SECTION_KEY]: "tasks" });
    expect(store.sidebarSections.getSnapshot().activeSection).toBe("home");
    expect(uiState.getItem(SECTION_KEY)).toBe("home");
  });

  it("leaves a live id alone", async () => {
    const { store, uiState } = await bootWith({ [SECTION_KEY]: "apps" });
    expect(store.sidebarSections.getSnapshot().activeSection).toBe("apps");
    expect(uiState.getItem(SECTION_KEY)).toBe("apps");
  });

  it("defaults to home with nothing persisted", async () => {
    const { store } = await bootWith({});
    expect(store.sidebarSections.getSnapshot().activeSection).toBe("home");
  });
});

describe("persisted sub-locations", () => {
  it("carries a pre-rename `tasks` sub-location over to home", async () => {
    const { store } = await bootWith({
      [LOCATIONS_KEY]: JSON.stringify({
        tasks: "thread:7",
        files: "pdf:/a.pdf",
        // The retired Search section persisted a null here; it has no
        // sub-location of its own and must not become one.
        search: null,
      }),
    });

    const locations = store.sidebarSections.getSnapshot().locations;
    expect(locations.home).toBe("thread:7");
    expect(locations.files).toBe("pdf:/a.pdf");
    expect(locations.apps).toBeNull();
    expect(locations).not.toHaveProperty("search");
    expect(locations).not.toHaveProperty("tasks");
  });

  it("prefers a post-rename `home` over a leftover `tasks`", async () => {
    const { store } = await bootWith({
      [LOCATIONS_KEY]: JSON.stringify({
        home: "thread:new",
        tasks: "thread:old",
      }),
    });
    expect(store.sidebarSections.getSnapshot().locations.home).toBe(
      "thread:new",
    );
  });

  it("degrades a malformed payload to the list views", async () => {
    const { store } = await bootWith({ [LOCATIONS_KEY]: "{not json" });
    expect(store.sidebarSections.getSnapshot().locations).toEqual({
      home: null,
      files: null,
      apps: null,
    });
  });
});
