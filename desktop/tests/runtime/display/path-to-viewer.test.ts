import { describe, expect, it } from "vitest";
import {
  basenameOf,
  extensionOf,
  isFallbackPreviewableExtension,
  isPreviewableExtension,
  kindForExtension,
  kindForPath,
  pickPrimaryEditedPath,
  tabIdForPath,
} from "../../../src/shell/display/path-to-viewer";

describe("extensionOf", () => {
  it("extracts lowercased extension from common paths", () => {
    expect(extensionOf("/a/b/c.PNG")).toBe("png");
    expect(extensionOf("/state/media/outputs/job_0.jpeg")).toBe("jpeg");
    expect(extensionOf("relative/file.docx")).toBe("docx");
    expect(extensionOf("Q4 invoice.pdf")).toBe("pdf");
  });

  it("strips query and hash before parsing", () => {
    expect(extensionOf("https://x.test/img.png?w=200")).toBe("png");
    expect(extensionOf("/a/b/x.gif#frag")).toBe("gif");
  });

  it("returns null for paths without an extension", () => {
    expect(extensionOf("README")).toBeNull();
    expect(extensionOf("/path/dir.with.dot/")).toBeNull();
    expect(extensionOf(".hidden")).toBeNull();
    expect(extensionOf("trailing.")).toBeNull();
    expect(extensionOf("")).toBeNull();
  });
});

describe("basenameOf", () => {
  it("returns the trailing component", () => {
    expect(basenameOf("/a/b/c.png")).toBe("c.png");
    expect(basenameOf("c.png")).toBe("c.png");
    expect(basenameOf("/a/b/")).toBe("");
    expect(basenameOf("https://x/y/z.gif?q=1")).toBe("z.gif");
  });
});

describe("kindForExtension / kindForPath", () => {
  it("dispatches images, pdfs, office, media, 3d", () => {
    expect(kindForExtension("png")).toBe("image");
    expect(kindForExtension("jpg")).toBe("image");
    expect(kindForExtension("avif")).toBe("image");
    expect(kindForExtension("svg")).toBe("image");

    expect(kindForExtension("pdf")).toBe("pdf");

    expect(kindForExtension("docx")).toBe("office-document");
    expect(kindForExtension("doc")).toBe("office-document");
    expect(kindForExtension("xlsx")).toBe("office-spreadsheet");
    expect(kindForExtension("csv")).toBe("office-spreadsheet");
    expect(kindForExtension("tsv")).toBe("office-spreadsheet");
    expect(kindForExtension("pptx")).toBe("office-slides");

    expect(kindForExtension("mp4")).toBe("video");
    expect(kindForExtension("webm")).toBe("video");

    expect(kindForExtension("mp3")).toBe("audio");
    expect(kindForExtension("wav")).toBe("audio");

    expect(kindForExtension("glb")).toBe("model3d");
    expect(kindForExtension("gltf")).toBe("model3d");
    expect(kindForExtension("md")).toBe("markdown");
    expect(kindForExtension("mdx")).toBe("markdown");
  });

  it("returns null for unknown extensions and unsupported types", () => {
    expect(kindForExtension(null)).toBeNull();
    expect(kindForExtension("zip")).toBeNull();
    expect(kindForExtension("html")).toBeNull();
    expect(kindForPath("/x/y/no-ext")).toBeNull();
  });
});

describe("tabIdForPath", () => {
  it("uses kind-prefixed stable ids", () => {
    expect(tabIdForPath("/x/y/foo.png")).toBe("media:image:/x/y/foo.png");
    expect(tabIdForPath("/x/y/foo.mp4")).toBe("media:video:/x/y/foo.mp4");
    expect(tabIdForPath("/x/y/foo.mp3")).toBe("media:audio:/x/y/foo.mp3");
    expect(tabIdForPath("/x/y/foo.glb")).toBe("media:model3d:/x/y/foo.glb");
    expect(tabIdForPath("/x/y/foo.pdf")).toBe("pdf:/x/y/foo.pdf");
    expect(tabIdForPath("/x/y/notes.md")).toBe("markdown:/x/y/notes.md");
    expect(tabIdForPath("/x/y/app.ts")).toBe("source-diff");
    expect(tabIdForPath("/x/y/other.py")).toBe("source-diff");
    expect(tabIdForPath("/x/y/foo.docx")).toBe("office:/x/y/foo.docx");
    expect(tabIdForPath("/x/y/foo.csv")).toBe("office:/x/y/foo.csv");
    expect(tabIdForPath("/x/y/README")).toBe("file:/x/y/README");
  });
});

describe("pickPrimaryEditedPath", () => {
  it("returns null for empty / blank-only inputs", () => {
    expect(pickPrimaryEditedPath([])).toBeNull();
    expect(pickPrimaryEditedPath(["", "  ", "\t"])).toBeNull();
  });

  it("dedupes by exact string", () => {
    expect(
      pickPrimaryEditedPath([
        "/a/b/foo.docx",
        "/a/b/foo.docx",
        "/a/b/foo.docx",
      ]),
    ).toBe("/a/b/foo.docx");
  });

  it("prefers the first preferred-set extension when many paths are present", () => {
    expect(
      pickPrimaryEditedPath([
        "/a/b/foo.txt",
        "/a/b/notes.md",
        "/a/b/report.pdf",
        "/a/b/data.json",
      ]),
    ).toBe("/a/b/report.pdf");

    expect(
      pickPrimaryEditedPath([
        "/a/b/cover.png",
        "/a/b/script.txt",
      ]),
    ).toBe("/a/b/cover.png");
  });

  it("falls back to the lone path when its extension is in the broader set", () => {
    expect(pickPrimaryEditedPath(["/a/b/notes.md"])).toBe("/a/b/notes.md");
    expect(pickPrimaryEditedPath(["/a/b/notes.txt"])).toBe("/a/b/notes.txt");
  });

  it("only falls back to developer resources when requested", () => {
    expect(pickPrimaryEditedPath(["/a/b/app.ts"])).toBeNull();
    expect(
      pickPrimaryEditedPath(["/a/b/app.ts"], {
        includeDeveloperResources: true,
      }),
    ).toBe("/a/b/app.ts");
    expect(
      pickPrimaryEditedPath(["/a/b/data.json"], {
        includeDeveloperResources: true,
      }),
    ).toBe("/a/b/data.json");
  });

  it("returns null for a single path with an extension outside both sets", () => {
    expect(pickPrimaryEditedPath(["/a/b/script.zip"])).toBeNull();
    expect(pickPrimaryEditedPath(["/a/b/no-extension"])).toBeNull();
  });

  it("returns null for many paths with no preferred extension", () => {
    expect(pickPrimaryEditedPath(["/a/b/x.txt", "/a/b/y.json"])).toBeNull();
  });

  it("uses markdown when a turn has no richer artifact", () => {
    expect(
      pickPrimaryEditedPath(["/a/b/app.ts", "/a/b/notes.md"], {
        includeDeveloperResources: true,
      }),
    ).toBe("/a/b/notes.md");
  });

  it("preferred-set guards include common media", () => {
    expect(isPreviewableExtension("png")).toBe(true);
    expect(isPreviewableExtension("mp4")).toBe(true);
    expect(isPreviewableExtension("pdf")).toBe(true);
    expect(isPreviewableExtension("docx")).toBe(true);
    expect(isPreviewableExtension("md")).toBe(false);
    expect(isFallbackPreviewableExtension("md")).toBe(true);
    expect(isFallbackPreviewableExtension("txt")).toBe(true);
    expect(isFallbackPreviewableExtension("json")).toBe(false);
  });
});
