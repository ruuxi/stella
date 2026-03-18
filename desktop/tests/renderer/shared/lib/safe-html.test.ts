import { describe, expect, it } from "vitest";
import { sanitizeHtmlFragment } from "../../../../src/shared/lib/safe-html";

describe("safe-html", () => {
  it("removes script tags and inline event handlers", () => {
    const html = `<div onclick="alert(1)">Hello<script>alert(1)</script></div>`;
    const sanitized = sanitizeHtmlFragment(html);

    expect(sanitized).toContain("Hello");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).not.toContain("<script");
  });

  it("strips unsafe URL protocols but keeps safe markup", () => {
    const html = `<a href="javascript:alert(1)">Open</a><img src="https://example.com/test.png" />`;
    const sanitized = sanitizeHtmlFragment(html);

    expect(sanitized).toContain(">Open<");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).toContain(`src="https://example.com/test.png"`);
  });
});
