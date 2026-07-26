import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/shell/display/tab-content", () => ({
  UrlTabContent: () => null,
  MarkdownTabContent: () => null,
  SourceDiffTabContent: () => null,
  PdfTabContent: () => null,
  OfficeTabContent: () => null,
  OfficeFileTabContent: () => null,
  DelimitedTableTabContent: () => null,
  MediaTabContent: () => null,
  TrashTabContent: () => null,
}));

// Registers the payload adapter as a side effect of importing, exactly as the
// shell does at boot; without it `openDisplayPayloadTab` has no mapper.
await import("../../../src/shell/display/payload-to-tab-spec");

const { openDisplayPayloadTab } = await import(
  "../../../src/features/workspace-display/open-payload"
);
const { sidebarSections } = await import(
  "../../../src/features/workspace-display/sidebar-sections"
);
const { displayTabs } = await import(
  "../../../src/features/workspace-display/tab-store"
);

const files = () => sidebarSections.getSnapshot().locations.files;
const panelOpen = () => displayTabs.getLayoutSnapshot().panelOpen;

beforeEach(() => {
  displayTabs.reset();
  sidebarSections.reset();
});

describe("payload → Files retargeting", () => {
  it("registers the viewer and puts the panel on Files", () => {
    openDisplayPayloadTab({
      kind: "markdown",
      filePath: "/tmp/notes.md",
      title: "notes.md",
    });

    expect(displayTabs.getTabListSnapshot().tabs.map((tab) => tab.id)).toEqual([
      "markdown:/tmp/notes.md",
    ]);
    expect(sidebarSections.getSnapshot().activeSection).toBe("files");
    expect(files()).toBe("markdown:/tmp/notes.md");
    expect(panelOpen()).toBe(true);
  });

  it("remembers a passively registered payload without opening the panel", () => {
    openDisplayPayloadTab(
      { kind: "pdf", filePath: "/tmp/report.pdf", title: "report.pdf" },
      { activate: false },
    );

    expect(displayTabs.getTabListSnapshot().tabs).toHaveLength(1);
    expect(files()).toBe("pdf:/tmp/report.pdf");
    expect(panelOpen()).toBe(false);
    expect(sidebarSections.getSnapshot().activeSection).toBe("home");
  });

  it("routes canvas and media into Files rather than their own tabs", () => {
    openDisplayPayloadTab({
      kind: "canvas-html",
      filePath: "/html/plan.html",
      title: "Plan",
      createdAt: 1,
    });
    expect(files()).toBe("canvas:/html/plan.html");

    openDisplayPayloadTab({
      kind: "media",
      asset: { kind: "image", filePaths: ["/out/cat.png"] },
      createdAt: 2,
    });
    expect(files()).toBe("image:/out/cat.png");
  });

  it("does not move an open Files section off the file being read", () => {
    openDisplayPayloadTab({
      kind: "markdown",
      filePath: "/tmp/notes.md",
      title: "notes.md",
    });
    expect(panelOpen()).toBe(true);

    // A background refresh, as the `display:update` IPC and the media
    // materializer both issue.
    openDisplayPayloadTab(
      { kind: "pdf", filePath: "/tmp/report.pdf", title: "report.pdf" },
      { activate: false },
    );

    expect(files()).toBe("markdown:/tmp/notes.md");
  });

  it("leaves Files alone for deferred-delete trash", () => {
    openDisplayPayloadTab({ kind: "trash", createdAt: 1 });

    expect(displayTabs.getTabListSnapshot().tabs).toHaveLength(1);
    expect(files()).toBeNull();
  });
});
