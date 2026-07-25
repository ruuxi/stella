import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayTabs } from "../../../src/features/workspace-display/tab-store";
import {
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

describe("selectSection — open / switch / close", () => {
  it("opens the panel to the selected section when closed", () => {
    expect(panelOpen()).toBe(false);
    sidebarSections.selectSection("files");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("files");
  });

  it("closes the panel when the already-active section is selected again", () => {
    sidebarSections.selectSection("files");
    sidebarSections.selectSection("files");
    expect(panelOpen()).toBe(false);
    // The section stays active so the next summon returns to it.
    expect(activeSection()).toBe("files");
  });

  it("switches to a different section and stays open", () => {
    sidebarSections.selectSection("files");
    sidebarSections.selectSection("apps");
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("apps");
  });

  it("reopens on the section it was closed from", () => {
    sidebarSections.selectSection("search");
    sidebarSections.selectSection("search"); // close
    expect(panelOpen()).toBe(false);
    sidebarSections.selectSection("search"); // reopen
    expect(panelOpen()).toBe(true);
    expect(activeSection()).toBe("search");
  });

  it("round-trips every section", () => {
    for (const section of SIDEBAR_SECTIONS) {
      sidebarSections.selectSection(section);
      expect(activeSection()).toBe(section);
      expect(panelOpen()).toBe(true);
      sidebarSections.selectSection(section);
      expect(panelOpen()).toBe(false);
    }
  });
});

describe("per-section memory", () => {
  it("restores a section's sub-location across close and reopen", () => {
    sidebarSections.selectSection("files");
    sidebarSections.setLocation("files", "pdf:/report.pdf");

    sidebarSections.selectSection("files"); // close
    expect(panelOpen()).toBe(false);
    sidebarSections.selectSection("files"); // reopen

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
    sidebarSections.selectSection("tasks");
    sidebarSections.selectSection("apps");
    expect(locations().apps).toBe("discipline");
  });

  it("clearLocation is the only way back to a section's list", () => {
    sidebarSections.openLocation("files", "canvas:html");
    sidebarSections.selectSection("files"); // close
    sidebarSections.selectSection("files"); // reopen
    expect(locations().files).toBe("canvas:html");

    sidebarSections.clearLocation("files");
    expect(locations().files).toBeNull();
  });

  it("search has no sub-location", () => {
    sidebarSections.setLocation("search", "anything");
    expect(locations().search).toBeNull();
  });
});

describe("openLocation", () => {
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
