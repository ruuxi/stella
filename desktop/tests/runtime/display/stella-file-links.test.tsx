import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import {
  displayPayloadForStellaFile,
  parseStellaFileUrl,
  remarkStellaFileLinks,
  STELLA_FILE_TAG,
  STELLA_FILE_TAG_ATTRIBUTES,
} from "../../../src/features/chat/lib/stella-file-links";
import { StellaFileLink } from "../../../src/app/chat/StellaFileLink";

describe("parseStellaFileUrl", () => {
  it("extracts the absolute path from the canonical form", () => {
    expect(parseStellaFileUrl("stella://file/Users/sam/report.pdf")).toBe(
      "/Users/sam/report.pdf",
    );
  });

  it("tolerates an extra slash before the path", () => {
    expect(parseStellaFileUrl("stella://file//Users/sam/report.pdf")).toBe(
      "/Users/sam/report.pdf",
    );
  });

  it("decodes percent-encoded segments", () => {
    expect(parseStellaFileUrl("stella://file/Users/sam/My%20File.pdf")).toBe(
      "/Users/sam/My File.pdf",
    );
  });

  it("accepts windows-style absolute paths", () => {
    expect(parseStellaFileUrl("stella://file/C:/Users/sam/report.pdf")).toBe(
      "C:/Users/sam/report.pdf",
    );
  });

  it("rejects other stella deep links and malformed refs", () => {
    expect(parseStellaFileUrl("stella://join/ABC123")).toBeNull();
    expect(parseStellaFileUrl("stella://filesystem/x")).toBeNull();
    expect(parseStellaFileUrl("stella://file")).toBeNull();
    expect(parseStellaFileUrl("stella://file/")).toBeNull();
    expect(parseStellaFileUrl("https://example.com/a.pdf")).toBeNull();
  });
});

describe("displayPayloadForStellaFile", () => {
  it("routes viewable types to their in-app viewer payloads", () => {
    expect(displayPayloadForStellaFile("/tmp/a.pdf", 1)).toMatchObject({
      kind: "pdf",
      filePath: "/tmp/a.pdf",
    });
    expect(displayPayloadForStellaFile("/tmp/demo.mp4", 1)).toMatchObject({
      kind: "media",
      asset: { kind: "video", filePath: "/tmp/demo.mp4" },
    });
    expect(displayPayloadForStellaFile("/tmp/pic.png", 1)).toMatchObject({
      kind: "media",
      asset: { kind: "image", filePaths: ["/tmp/pic.png"] },
    });
    expect(displayPayloadForStellaFile("/tmp/notes.md", 1)).toMatchObject({
      kind: "markdown",
      filePath: "/tmp/notes.md",
    });
  });

  it("opens ANY html file as a canvas, not just outputs-tree html", () => {
    expect(
      displayPayloadForStellaFile("/Users/sam/site/index.html", 1),
    ).toMatchObject({ kind: "canvas-html", filePath: "/Users/sam/site/index.html" });
    expect(
      displayPayloadForStellaFile(
        "/Users/sam/.stella/outputs/html/city-guide.html",
        1,
      ),
    ).toMatchObject({ kind: "canvas-html", slug: "city-guide" });
  });

  it("returns null for types with no in-app viewer (external fallback)", () => {
    expect(displayPayloadForStellaFile("/tmp/archive.zip", 1)).toBeNull();
    expect(displayPayloadForStellaFile("/tmp/no-extension", 1)).toBeNull();
  });
});

describe("stella-file chat rendering round-trip", () => {
  // Mirrors the exact Streamdown recipe in `Markdown.tsx`: default remark
  // plugins + the stella-file rewriter, default rehype plugins (prop
  // omitted so `allowedTags` engages), and the component mapping.
  const render = (markdown: string) =>
    renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          remarkPlugins: [
            ...Object.values(defaultRemarkPlugins),
            remarkStellaFileLinks,
          ],
          components: { [STELLA_FILE_TAG]: StellaFileLink },
          allowedTags: {
            [STELLA_FILE_TAG]: [...STELLA_FILE_TAG_ATTRIBUTES],
          },
          linkSafety: { enabled: false },
        },
        markdown,
      ),
    );

  it("renders a markdown-form reference as an inline clickable link", () => {
    const html = render(
      "Here's [the report](stella://file/Users/sam/.stella/outputs/report.pdf) you asked for.",
    );
    expect(html).toContain("markdown-stella-file");
    expect(html).toContain(">the report</a>");
    expect(html).toContain("/Users/sam/.stella/outputs/report.pdf");
    expect(html).not.toContain("[blocked]");
  });

  it("renders a bare stella://file URI with the filename as label", () => {
    const html = render(
      "Saved to stella://file/Users/sam/Movies/demo.mp4, take a look.",
    );
    expect(html).toContain("markdown-stella-file");
    expect(html).toContain(">demo.mp4</a>");
    // The raw URI must not remain visible in the prose.
    expect(html).not.toContain("stella://file/");
  });

  it("leaves invalid references as plain text", () => {
    const html = render("A busted link: [x](stella://file/) here.");
    expect(html).not.toContain("markdown-stella-file");
  });

  it("does not rewrite references inside code spans", () => {
    const html = render("Use `stella://file/Users/sam/a.pdf` as the format.");
    expect(html).not.toContain("markdown-stella-file");
    expect(html).toContain("stella://file/Users/sam/a.pdf");
  });

  it("keeps normal links untouched", () => {
    const html = render("See [docs](https://example.com/docs).");
    expect(html).toContain('href="https://example.com/docs"');
  });
});
