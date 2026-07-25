import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetArtifactFileEntry,
  getFileEntries,
  recordArtifactFileEntry,
  setFileEntries,
  subscribeFileEntries,
  type FileEntry,
} from "../../../src/features/workspace-display/files-index";

const canvasEntry = (filePath: string, createdAt: number): FileEntry => ({
  source: "canvas",
  id: `canvas:${filePath}`,
  kind: "canvas",
  title: filePath,
  filePath,
  createdAt,
  payload: { kind: "canvas-html", filePath, createdAt },
});

const mediaEntry = (filePath: string, createdAt: number): FileEntry => ({
  source: "media",
  id: `image:${filePath}`,
  kind: "image",
  title: filePath,
  filePath,
  createdAt,
  payload: {
    kind: "media",
    asset: { kind: "image", filePaths: [filePath] },
    createdAt,
  },
});

const ids = () => getFileEntries().map((entry) => entry.id);

beforeEach(() => {
  setFileEntries("canvas", []);
  setFileEntries("media", []);
  for (const entry of getFileEntries()) {
    if (entry.source === "artifact") forgetArtifactFileEntry(entry.id);
  }
});

describe("files index", () => {
  it("merges every source into one newest-first list", () => {
    setFileEntries("canvas", [canvasEntry("/html/plan.html", 20)]);
    setFileEntries("media", [mediaEntry("/out/cat.png", 30)]);
    recordArtifactFileEntry({
      id: "pdf:/tmp/report.pdf",
      kind: "pdf",
      title: "report.pdf",
      filePath: "/tmp/report.pdf",
      createdAt: 10,
      payload: { kind: "pdf", filePath: "/tmp/report.pdf" },
    });

    expect(ids()).toEqual([
      "image:/out/cat.png",
      "canvas:/html/plan.html",
      "pdf:/tmp/report.pdf",
    ]);
  });

  it("orders equal timestamps by id so the list never reshuffles", () => {
    setFileEntries("canvas", [
      canvasEntry("/html/b.html", 5),
      canvasEntry("/html/a.html", 5),
    ]);

    expect(ids()).toEqual(["canvas:/html/a.html", "canvas:/html/b.html"]);
  });

  it("de-duplicates by id, keeping the fresher record", () => {
    setFileEntries("canvas", [canvasEntry("/html/plan.html", 1)]);
    setFileEntries("media", [
      { ...canvasEntry("/html/plan.html", 9), source: "media" },
    ]);

    expect(ids()).toEqual(["canvas:/html/plan.html"]);
    expect(getFileEntries()[0]?.createdAt).toBe(9);
  });

  it("replaces a source's whole contribution rather than appending", () => {
    setFileEntries("canvas", [canvasEntry("/html/a.html", 1)]);
    setFileEntries("canvas", [canvasEntry("/html/b.html", 2)]);

    expect(ids()).toEqual(["canvas:/html/b.html"]);
  });

  it("refreshes an artifact entry in place instead of stacking it", () => {
    const record = (createdAt: number) =>
      recordArtifactFileEntry({
        id: "markdown:/tmp/notes.md",
        kind: "markdown",
        title: "notes.md",
        filePath: "/tmp/notes.md",
        createdAt,
        payload: { kind: "markdown", filePath: "/tmp/notes.md", createdAt },
      });
    record(1);
    record(4);

    expect(ids()).toEqual(["markdown:/tmp/notes.md"]);
    expect(getFileEntries()[0]?.createdAt).toBe(4);
  });

  it("tombstones a forgotten artifact and brings it back when re-recorded", () => {
    const entry = {
      id: "url:preview",
      kind: "url" as const,
      title: "Preview",
      createdAt: 1,
      payload: {
        kind: "url" as const,
        url: "http://127.0.0.1:1/",
        title: "Preview",
        tabId: "url:preview",
      },
    };
    recordArtifactFileEntry(entry);
    forgetArtifactFileEntry("url:preview");
    expect(ids()).not.toContain("url:preview");

    recordArtifactFileEntry(entry);
    expect(ids()).toContain("url:preview");
  });

  it("notifies subscribers on every mutation", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFileEntries(listener);

    setFileEntries("canvas", [canvasEntry("/html/a.html", 1)]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setFileEntries("canvas", []);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
