import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveContextContainerLabel,
  resolveContextContainers,
} from "../../../../src/shared/lib/stella-context-containers";

type RectInit = {
  top: number;
  left: number;
  width: number;
  height: number;
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

describe("stella context containers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    setRect(document.body, { top: 0, left: 0, width: 1000, height: 800 });
  });

  it("resolves tight and broad ancestors from the clicked target", () => {
    const contentArea = document.createElement("div");
    contentArea.className = "content-area";

    const section = document.createElement("section");
    section.setAttribute("data-stella-label", "Composer");

    const row = document.createElement("div");
    const button = document.createElement("button");
    button.textContent = "Send";

    row.append(button);
    section.append(row);
    contentArea.append(section);
    document.body.append(contentArea);

    setRect(contentArea, { top: 0, left: 0, width: 950, height: 700 });
    setRect(section, { top: 80, left: 40, width: 400, height: 260 });
    setRect(row, { top: 120, left: 60, width: 220, height: 80 });
    setRect(button, { top: 140, left: 80, width: 100, height: 32 });

    const resolved = resolveContextContainers(button);

    expect(resolved.tight).toBe(section);
    expect(resolved.broad).toBe(contentArea);
  });

  it("falls back to the main region and derives labels from heading text", () => {
    const main = document.createElement("main");
    const card = document.createElement("div");
    const heading = document.createElement("h2");
    heading.textContent = "Weekly overview and status updates";
    const paragraph = document.createElement("p");
    paragraph.textContent = "Summary";
    const target = document.createElement("span");
    target.textContent = "inside";

    card.append(heading, paragraph, target);
    main.append(card);
    document.body.append(main);

    setRect(main, { top: 0, left: 0, width: 700, height: 500 });
    setRect(card, { top: 40, left: 20, width: 180, height: 90 });
    setRect(heading, { top: 50, left: 30, width: 160, height: 22 });
    setRect(paragraph, { top: 76, left: 30, width: 120, height: 20 });
    setRect(target, { top: 100, left: 30, width: 40, height: 16 });

    const resolved = resolveContextContainers(target);

    expect(resolved.tight).toBe(main);
    expect(resolved.broad).toBe(document.body);
    expect(deriveContextContainerLabel(card)).toBe("Weekly overview and status updates");
  });
});
