import { describe, expect, it } from "vitest";
import {
  getDisplayPayloadTitle,
  isDisplayPayload,
  normalizeDisplayPayload,
  type DisplayPayload,
} from "../../src/shared/contracts/display-payload";

describe("normalizeDisplayPayload", () => {
  it("wraps a non-empty string into { kind: 'html' }", () => {
    expect(normalizeDisplayPayload("<p>hi</p>")).toEqual({
      kind: "html",
      html: "<p>hi</p>",
    });
  });

  it("returns null for blank strings", () => {
    expect(normalizeDisplayPayload("")).toBeNull();
    expect(normalizeDisplayPayload("   \n\t")).toBeNull();
  });

  it("passes through valid html payloads", () => {
    const payload: DisplayPayload = { kind: "html", html: "<x/>" };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through valid office payloads", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "session-1",
        title: "deck.pptx",
        sourcePath: "/tmp/deck.pptx",
      },
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through valid pdf payloads", () => {
    const payload: DisplayPayload = {
      kind: "pdf",
      filePath: "/tmp/invoice.pdf",
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("rejects malformed payloads", () => {
    expect(normalizeDisplayPayload(null)).toBeNull();
    expect(normalizeDisplayPayload(undefined)).toBeNull();
    expect(normalizeDisplayPayload(42)).toBeNull();
    expect(normalizeDisplayPayload({ kind: "html" })).toBeNull();
    expect(normalizeDisplayPayload({ kind: "office", previewRef: {} })).toBeNull();
    expect(normalizeDisplayPayload({ kind: "pdf" })).toBeNull();
    expect(normalizeDisplayPayload({ kind: "unknown" })).toBeNull();
  });

  it("isDisplayPayload narrows correctly", () => {
    expect(isDisplayPayload({ kind: "html", html: "x" })).toBe(true);
    expect(isDisplayPayload({ kind: "html" })).toBe(false);
  });

  it("derives reasonable titles", () => {
    expect(getDisplayPayloadTitle({ kind: "html", html: "x" })).toBe("Display");
    expect(
      getDisplayPayloadTitle({
        kind: "office",
        previewRef: {
          sessionId: "s",
          title: "report.docx",
          sourcePath: "/a/report.docx",
        },
      }),
    ).toBe("report.docx");
    expect(
      getDisplayPayloadTitle({
        kind: "pdf",
        filePath: "/a/b/invoice.pdf",
      }),
    ).toBe("invoice.pdf");
    expect(
      getDisplayPayloadTitle({
        kind: "pdf",
        filePath: "/a/b/invoice.pdf",
        title: "Q4 invoice",
      }),
    ).toBe("Q4 invoice");
  });
});
