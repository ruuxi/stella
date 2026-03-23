import { beforeEach, describe, expect, it } from "vitest";
import { initStellaUiHandler } from "../../../../src/platform/electron/stella-ui-handler";
import { buildScopedSnapshot } from "../../../../src/shell/context-menu/context-capture";

type RectInit = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type StellaUiGlobal = {
  snapshot: () => string;
  handleCommand: (command: string, args: string[]) => string;
};

function setRect(el: Element, rect: RectInit) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => ({}),
    }),
  });
}

describe("stella DOM snapshot helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete ((window as unknown as Record<string, unknown>)).__stellaUI;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  });

  it("buildScopedSnapshot keeps viewport-visible scoped content and omits skipped nodes", () => {
    const section = document.createElement("section");
    section.setAttribute("data-stella-label", "Panel");

    const button = document.createElement("button");
    button.textContent = "Save";

    const summary = document.createElement("span");
    summary.textContent = "Summary";

    const offscreenButton = document.createElement("button");
    offscreenButton.textContent = "Hidden action";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const svgContainer = document.createElement("div");
    svgContainer.append(svg);

    section.append(button, summary, offscreenButton, svgContainer);
    document.body.append(section);

    setRect(section, { top: 10, left: 10, width: 500, height: 300 });
    setRect(button, { top: 30, left: 20, width: 100, height: 30 });
    setRect(summary, { top: 70, left: 20, width: 140, height: 20 });
    setRect(offscreenButton, { top: 700, left: 20, width: 120, height: 30 });
    setRect(svgContainer, { top: 100, left: 20, width: 50, height: 50 });
    setRect(svg, { top: 100, left: 20, width: 50, height: 50 });

    expect(buildScopedSnapshot(section)).toBe(["[Panel]", "  [btn] Save", "  Summary"].join("\n"));
  });

  it("initStellaUiHandler snapshots interactive elements with refs and can act on them", () => {
    let clicked = 0;

    const view = document.createElement("div");
    view.setAttribute("data-stella-view", "home");
    view.setAttribute("data-stella-label", "Home Dashboard");

    const button = document.createElement("button");
    button.textContent = "Launch";
    button.addEventListener("click", () => {
      clicked += 1;
    });

    const input = document.createElement("input");
    input.placeholder = "Search";
    input.value = "alpha";

    view.append(button, input);
    document.body.append(view);

    setRect(document.body, { top: 0, left: 0, width: 800, height: 600 });
    setRect(view, { top: 0, left: 0, width: 800, height: 600 });
    setRect(button, { top: 40, left: 30, width: 100, height: 30 });
    setRect(input, { top: 90, left: 30, width: 180, height: 30 });

    initStellaUiHandler();
    const ui = (window as unknown as Record<string, unknown>).__stellaUI as StellaUiGlobal;

    expect(ui.snapshot()).toBe(
      [
        "[view: home]",
        "[Home Dashboard]",
        "  [btn @e1] Launch",
        '  [input @e2] Search: "alpha"',
      ].join("\n"),
    );

    expect(ui.handleCommand("click", ["@e1"])).toBe("Clicked @e1");
    expect(clicked).toBe(1);

    expect(ui.handleCommand("fill", ["@e2", "updated text"])).toBe(
      'Filled @e2 with "updated text"',
    );
    expect(input.value).toBe("updated text");
  });
});
