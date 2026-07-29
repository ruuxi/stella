import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayTabs } from "../../../src/features/workspace-display/tab-store";
import {
  LEGACY_SIDEBAR_SECTION_IDS,
  resolveSidebarSection,
  sidebarSections,
  SIDEBAR_SECTIONS,
} from "../../../src/features/workspace-display/sidebar-sections";

const panelOpen = () => displayTabs.getLayoutSnapshot().panelOpen;
const activeSection = () => sidebarSections.getSnapshot().activeSection;
const locations = () => sidebarSections.getSnapshot().locations;

beforeEach(() => {
  displayTabs.reset();
  sidebarSections.reset();
});

afterEach(() => {
  displayTabs.reset();
  sidebarSections.reset();
});

describe("selectSection — open / switch / reset", () => {
  it("opens the panel to the selected section when closed", () => {
    expect(panelOpen()).toBe(false);
    sidebarSections.selectSection("files");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("files");
  });

  it("does nothing when the active section is already at its default view", () => {
    sidebarSections.selectSection("files");
    sidebarSections.selectSection("files");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("files");
  });

  it("switches to a different section and stays open", () => {
    sidebarSections.selectSection("files");
    sidebarSections.selectSection("apps");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("apps");
  });

  it("returns the active section to its default view when drilled in", () => {
    sidebarSections.openLocation("apps", "discipline");
    sidebarSections.selectSection("apps");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("apps");
    expect(locations().apps).toBeNull();
  });
});

describe("per-section memory", () => {
  it("keeps a section's sub-location while switching away and back", () => {
    sidebarSections.selectSection("files");
    sidebarSections.setLocation("files", "pdf:/report.pdf");

    sidebarSections.selectSection("home");
    sidebarSections.selectSection("files");

    expect(locations().files).toBe("pdf:/report.pdf");
  });

  it("keeps each section's location independent while switching", () => {
    sidebarSections.openLocation("files", "markdown:/notes.md");
    sidebarSections.openLocation("apps", "discipline");

    expect(locations().files).toBe("markdown:/notes.md");
    expect(locations().apps).toBe("discipline");

    sidebarSections.selectSection("files");
    expect(activeSection()).toBe("files");
    expect(locations().files).toBe("markdown:/notes.md");
    expect(locations().apps).toBe("discipline");
  });

  it("switching away and back does not reset to the list view", () => {
    sidebarSections.openLocation("apps", "discipline");
    sidebarSections.selectSection("home");
    sidebarSections.selectSection("apps");
    expect(locations().apps).toBe("discipline");
  });

  it("selecting the active tab clears its location", () => {
    sidebarSections.openLocation("files", "canvas:html");
    sidebarSections.selectSection("files");
    expect(locations().files).toBeNull();
    expect(panelOpen()).toBe(true);
  });
});

describe("retired section ids", () => {
  it("resolves the ids the rename left behind to home", () => {
    expect([...LEGACY_SIDEBAR_SECTION_IDS].sort()).toEqual(["search", "tasks"]);
    for (const legacy of LEGACY_SIDEBAR_SECTION_IDS) {
      expect(resolveSidebarSection(legacy)).toBe("home");
    }
  });

  it("resolves anything unrecognizable to home rather than passing it on", () => {
    for (const value of [null, undefined, "", "notes", 7, {}, "__proto__"]) {
      expect(resolveSidebarSection(value)).toBe("home");
    }
  });

  it("keeps live ids untouched", () => {
    for (const section of SIDEBAR_SECTIONS) {
      expect(resolveSidebarSection(section)).toBe(section);
    }
  });

  // The store is the boundary: whatever a caller hands it — an IPC wedge, a
  // rehydrated value, a call site the rename missed — `activeSection` only
  // ever holds an id that has a section behind it.
  it("never seats a retired id as the active section", () => {
    sidebarSections.setActiveSection("tasks" as unknown as "home");
    expect(sidebarSections.getSnapshot().activeSection).toBe("home");

    sidebarSections.setActiveSection("search" as unknown as "home");
    expect(sidebarSections.getSnapshot().activeSection).toBe("home");
  });

  it("routes retired Home ids to the standalone surface", () => {
    sidebarSections.selectSection("files");
    expect(panelOpen()).toBe(true);

    sidebarSections.selectSection("tasks" as unknown as "home");
    expect(activeSection()).toBe("home");
    expect(panelOpen()).toBe(false);

    // Selecting standalone Home again remains closed.
    sidebarSections.selectSection("tasks" as unknown as "home");
    expect(panelOpen()).toBe(false);
  });

  it("files a retired id's sub-location under its successor", () => {
    sidebarSections.setLocation("tasks" as unknown as "home", "thread:42");
    expect(locations().home).toBe("thread:42");
    expect(locations()).not.toHaveProperty("tasks");
  });
});

describe("openLocation", () => {
  it("shows a Home location outside the panel and closes the panel", () => {
    sidebarSections.selectSection("files");
    sidebarSections.openLocation("home", "thread:42");
    expect(panelOpen()).toBe(false);
    expect(activeSection()).toBe("home");
    expect(locations().home).toBe("thread:42");
  });

  it("targets a section, records the location, and opens the panel", () => {
    expect(panelOpen()).toBe(false);
    sidebarSections.openLocation("files", "image:/cat.png");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("files");
    expect(locations().files).toBe("image:/cat.png");
  });

  it("does not toggle the panel closed when already open on that section", () => {
    sidebarSections.selectSection("files");
    sidebarSections.openLocation("files", "image:/cat.png");
    expect(panelOpen()).toBe(true);
  });
});
