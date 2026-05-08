import { describe, expect, it } from "vitest";
import {
  getDisplayPayloadTitle,
  isDisplayPayload,
  normalizeDisplayPayload,
  type DisplayPayload,
} from "../../src/shared/contracts/display-payload";

describe("normalizeDisplayPayload", () => {
  it("rejects string payloads", () => {
    expect(normalizeDisplayPayload("<p>hi</p>")).toBeNull();
    expect(normalizeDisplayPayload("")).toBeNull();
    expect(normalizeDisplayPayload("   \n\t")).toBeNull();
  });

  it("passes through canvas-html payloads", () => {
    const payload: DisplayPayload = {
      kind: "canvas-html",
      filePath: "/state/outputs/html/plan.html",
      title: "Onboarding plan",
      slug: "plan",
      createdAt: 1,
    };
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

  it("passes through markdown and source diff payloads", () => {
    const markdown: DisplayPayload = {
      kind: "markdown",
      filePath: "/tmp/notes.md",
      title: "notes.md",
    };
    const sourceDiff: DisplayPayload = {
      kind: "source-diff",
      filePath: "/tmp/app.ts",
      patch: "*** Begin Patch\n*** End Patch",
      createdAt: 1,
    };
    expect(normalizeDisplayPayload(markdown)).toBe(markdown);
    expect(normalizeDisplayPayload(sourceDiff)).toBe(sourceDiff);
  });

  it("passes through http and https URL payloads", () => {
    const local: DisplayPayload = {
      kind: "url",
      url: "http://localhost:5173/social/session-1",
      title: "Social",
      tabId: "social:session-1",
    };
    const secure: DisplayPayload = {
      kind: "url",
      url: "https://example.com/preview",
      title: "Preview",
      tabId: "preview",
    };

    expect(normalizeDisplayPayload(local)).toBe(local);
    expect(normalizeDisplayPayload(secure)).toBe(secure);
  });

  it("rejects URL payloads with non-web protocols", () => {
    const base = {
      kind: "url",
      title: "Preview",
      tabId: "preview",
    };

    expect(
      normalizeDisplayPayload({ ...base, url: "file:///Users/me/.ssh/id_rsa" }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({ ...base, url: "javascript:alert(1)" }),
    ).toBeNull();
    expect(normalizeDisplayPayload({ ...base, url: "/relative" })).toBeNull();
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
    expect(normalizeDisplayPayload({ kind: "canvas-html" })).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "canvas-html",
        filePath: "/x.html",
      }),
    ).toBeNull();
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
    expect(
      isDisplayPayload({
        kind: "canvas-html",
        filePath: "/x.html",
        createdAt: 1,
      }),
    ).toBe(true);
    expect(isDisplayPayload({ kind: "canvas-html" })).toBe(false);
  });

  it("derives reasonable titles", () => {
    expect(
      getDisplayPayloadTitle({
        kind: "canvas-html",
        filePath: "/state/outputs/html/plan.html",
        createdAt: 1,
      }),
    ).toBe("plan.html");
    expect(
      getDisplayPayloadTitle({
        kind: "canvas-html",
        filePath: "/state/outputs/html/plan.html",
        title: "Onboarding plan",
        createdAt: 1,
      }),
    ).toBe("Onboarding plan");
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
        kind: "markdown",
        filePath: "/a/b/notes.md",
      }),
    ).toBe("notes.md");
    expect(
      getDisplayPayloadTitle({
        kind: "source-diff",
        filePath: "/a/b/app.ts",
      }),
    ).toBe("app.ts");
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
