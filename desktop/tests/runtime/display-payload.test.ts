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

  it("passes through valid file artifact payloads", () => {
    const payload: DisplayPayload = {
      kind: "file-artifact",
      filePath: "/tmp/report.docx",
      artifactKind: "office-document",
      title: "report.docx",
      createdAt: 1,
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through valid media payloads", () => {
    const image: DisplayPayload = {
      kind: "media",
      asset: {
        kind: "image",
        filePaths: ["/state/media/outputs/job_0.png"],
      },
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a cat",
      createdAt: 123,
    };
    expect(normalizeDisplayPayload(image)).toBe(image);

    const video: DisplayPayload = {
      kind: "media",
      asset: { kind: "video", filePath: "/state/media/outputs/job_0.mp4" },
      jobId: "job-2",
      createdAt: 456,
    };
    expect(normalizeDisplayPayload(video)).toBe(video);
  });

  it("rejects malformed payloads", () => {
    expect(normalizeDisplayPayload(null)).toBeNull();
    expect(normalizeDisplayPayload(undefined)).toBeNull();
    expect(normalizeDisplayPayload(42)).toBeNull();
    expect(normalizeDisplayPayload({ kind: "html" })).toBeNull();
    expect(
      normalizeDisplayPayload({ kind: "office", previewRef: {} }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "file-artifact",
        filePath: "/tmp/a.docx",
      }),
    ).toBeNull();
    expect(normalizeDisplayPayload({ kind: "pdf" })).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "media",
        asset: { kind: "image" }, // missing filePaths
        createdAt: 1,
      }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "media",
        asset: { kind: "image", filePaths: [] }, // ok shape, but no createdAt
      }),
    ).toBeNull();
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
        kind: "file-artifact",
        filePath: "/a/b/report.docx",
        artifactKind: "office-document",
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

    expect(
      getDisplayPayloadTitle({
        kind: "media",
        asset: { kind: "image", filePaths: ["/a/b/c.png"] },
        prompt: "a serene lake at dawn",
        capability: "text_to_image",
        createdAt: 1,
      }),
    ).toBe("a serene lake at dawn");

    expect(
      getDisplayPayloadTitle({
        kind: "media",
        asset: { kind: "video", filePath: "/a/b/c.mp4" },
        capability: "text_to_video",
        createdAt: 1,
      }),
    ).toBe("text to video");

    expect(
      getDisplayPayloadTitle({
        kind: "media",
        asset: { kind: "audio", filePath: "/a/b/c.mp3" },
        createdAt: 1,
      }),
    ).toBe("Generated audio");
  });
});
