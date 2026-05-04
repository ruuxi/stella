import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/shell/display/tab-content", () => ({
  UrlTabContent: () => null,
  MarkdownTabContent: () => null,
  SourceDiffTabContent: () => null,
  ImageTabContent: () => null,
  PdfTabContent: () => null,
  OfficeTabContent: () => null,
  OfficeFileTabContent: () => null,
  DelimitedTableTabContent: () => null,
  VideoTabContent: () => null,
  AudioTabContent: () => null,
  Model3dTabContent: () => null,
  DownloadTabContent: () => null,
  TextTabContent: () => null,
  TrashTabContent: () => null,
}));
vi.mock("../../../src/shell/display/tab-content.tsx", () => ({
  UrlTabContent: () => null,
  MarkdownTabContent: () => null,
  SourceDiffTabContent: () => null,
  ImageTabContent: () => null,
  PdfTabContent: () => null,
  OfficeTabContent: () => null,
  OfficeFileTabContent: () => null,
  DelimitedTableTabContent: () => null,
  VideoTabContent: () => null,
  AudioTabContent: () => null,
  Model3dTabContent: () => null,
  DownloadTabContent: () => null,
  TextTabContent: () => null,
  TrashTabContent: () => null,
}));

import type { DisplayPayload } from "../../../src/shared/contracts/display-payload";

const { payloadToTabSpec } = await import(
  "../../../src/shell/display/payload-to-tab-spec"
);

describe("payloadToTabSpec", () => {
  it("refuses to build a tab spec for html canvas payloads (renders inline)", () => {
    const payload: DisplayPayload = {
      kind: "html",
      html: "<canvas></canvas><script>window.ready = true</script>",
      title: "Canvas",
      createdAt: 42,
    };
    expect(() => payloadToTabSpec(payload)).toThrow();
  });

  it("keeps docx office previews as office-document tabs", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "s1",
        title: "report.docx",
        sourcePath: "/tmp/report.docx",
      },
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-document");
  });

  it("maps xlsx office previews to office-spreadsheet tabs", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "s2",
        title: "budget.xlsx",
        sourcePath: "/tmp/budget.xlsx",
      },
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-spreadsheet");
  });

  it("maps pptx office previews to office-slides tabs", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "s3",
        title: "deck.pptx",
        sourcePath: "/tmp/deck.pptx",
      },
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-slides");
  });

  it("maps file-backed xlsx artifacts to spreadsheet tabs", () => {
    const payload: DisplayPayload = {
      kind: "file-artifact",
      filePath: "/tmp/budget.xlsx",
      artifactKind: "office-spreadsheet",
      title: "budget.xlsx",
      createdAt: 42,
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("file-artifact:/tmp/budget.xlsx");
    expect(spec.kind).toBe("office-spreadsheet");
  });

  it("maps csv artifacts to spreadsheet tabs", () => {
    const payload: DisplayPayload = {
      kind: "file-artifact",
      filePath: "/tmp/data.csv",
      artifactKind: "delimited-table",
      title: "data.csv",
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-spreadsheet");
  });

  it("maps markdown files to markdown tabs", () => {
    const payload: DisplayPayload = {
      kind: "markdown",
      filePath: "/tmp/notes.md",
      title: "notes.md",
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("markdown:/tmp/notes.md");
    expect(spec.kind).toBe("markdown");
  });

  it("maps url payloads to url tabs and preserves the stable tab id", () => {
    const payload: DisplayPayload = {
      kind: "url",
      url: "http://127.0.0.1:53121/",
      title: "Social",
      tabId: "social:abc123",
      tooltip: "http://127.0.0.1:53121/",
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("social:abc123");
    expect(spec.kind).toBe("url");
    expect(spec.title).toBe("Social");
    expect(spec.tooltip).toBe("http://127.0.0.1:53121/");
  });

  it("maps developer file changes to source diff tabs", () => {
    const payload: DisplayPayload = {
      kind: "source-diff",
      filePath: "/tmp/app.ts",
      title: "app.ts",
      patch: "*** Begin Patch\n*** End Patch",
      createdAt: 7,
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("source-diff:/tmp/app.ts:7");
    expect(spec.kind).toBe("source-diff");
  });
});
