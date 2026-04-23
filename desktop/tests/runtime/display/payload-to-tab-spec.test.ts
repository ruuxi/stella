import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/shell/display/tab-content", () => ({
  HtmlTabContent: () => null,
  ImageTabContent: () => null,
  PdfTabContent: () => null,
  OfficeTabContent: () => null,
  VideoTabContent: () => null,
  AudioTabContent: () => null,
  Model3dTabContent: () => null,
  DownloadTabContent: () => null,
  TextTabContent: () => null,
}));

import { payloadToTabSpec } from "../../../src/shell/display/payload-to-tab-spec";
import type { DisplayPayload } from "../../../src/shared/contracts/display-payload";

describe("payloadToTabSpec", () => {
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
});
