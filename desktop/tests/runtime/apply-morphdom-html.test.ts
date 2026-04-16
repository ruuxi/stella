import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { applyMorphdomHtml } from "../../src/shell/apply-morphdom-html";

describe("applyMorphdomHtml", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "dangerously",
      url: "http://localhost",
    });

    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("Element", dom.window.Element);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("HTMLScriptElement", dom.window.HTMLScriptElement);
    vi.stubGlobal("SVGElement", dom.window.SVGElement);
    vi.stubGlobal("DocumentFragment", dom.window.DocumentFragment);
  });

  afterEach(() => {
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it("executes inline scripts for display html", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    applyMorphdomHtml(
      container,
      "display-sidebar__content",
      `
        <div id="output">pending</div>
        <script>
          window.__displayRuns = (window.__displayRuns ?? 0) + 1;
          document.getElementById("output").textContent = "ran";
        </script>
      `,
      { executeScripts: true },
    );

    expect(container.querySelector("#output")?.textContent).toBe("ran");
    expect((window as typeof window & { __displayRuns?: number }).__displayRuns).toBe(1);
  });

  it("does not rerun unchanged scripts on identical updates", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const html = `
      <div id="output">pending</div>
      <script>
        window.__displayRuns = (window.__displayRuns ?? 0) + 1;
        document.getElementById("output").textContent = "ran";
      </script>
    `;

    applyMorphdomHtml(container, "display-sidebar__content", html, {
      executeScripts: true,
    });
    applyMorphdomHtml(container, "display-sidebar__content", html, {
      executeScripts: true,
    });

    expect((window as typeof window & { __displayRuns?: number }).__displayRuns).toBe(1);
  });

  it("reruns scripts when the script content changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    applyMorphdomHtml(
      container,
      "display-sidebar__content",
      `
        <div id="output">pending</div>
        <script>
          window.__displayRuns = (window.__displayRuns ?? 0) + 1;
          document.getElementById("output").textContent = "first";
        </script>
      `,
      { executeScripts: true },
    );

    applyMorphdomHtml(
      container,
      "display-sidebar__content",
      `
        <div id="output">pending</div>
        <script>
          window.__displayRuns = (window.__displayRuns ?? 0) + 2;
          document.getElementById("output").textContent = "second";
        </script>
      `,
      { executeScripts: true },
    );

    expect(container.querySelector("#output")?.textContent).toBe("second");
    expect((window as typeof window & { __displayRuns?: number }).__displayRuns).toBe(3);
  });
});
