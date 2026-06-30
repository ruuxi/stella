// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRevealState } from "@/app/chat/streaming-text-reveal-frontier";
import {
  buildRevealMask,
  findCodeBlockBottom,
} from "@/app/chat/streaming-text-reveal-mask";

const countLayers = (maskImage: string): number =>
  maskImage.split("linear-gradient").length - 1;

describe("buildRevealMask", () => {
  it("emits only the two reveal layers for plain prose (no chrome band)", () => {
    const state = createRevealState();
    state.lineTop = 10;
    state.lineBottom = 30;
    state.x = 100;
    // Prose: clipBottom collapses to the caret line bottom.
    const mask = buildRevealMask(state, 30, 30);
    expect(countLayers(mask.maskImage)).toBe(2);
    expect(mask.maskSize).toBe("100% 10px, 100% 20px");
    expect(mask.maskPosition).toBe("0 0, 0 10px");
    expect(mask.maskRepeat).toBe("no-repeat, no-repeat");
  });

  it("adds an opaque chrome band below the last line for code blocks", () => {
    const state = createRevealState();
    state.lineTop = 10;
    state.lineBottom = 30;
    state.x = 100;
    // 25px of card chrome (padding + border + rounded corner) below the line.
    const mask = buildRevealMask(state, 30, 55);
    expect(countLayers(mask.maskImage)).toBe(3);
    expect(mask.maskSize).toBe("100% 10px, 100% 20px, 100% 25px");
    expect(mask.maskPosition).toBe("0 0, 0 10px, 0 30px");
    expect(mask.maskRepeat).toBe("no-repeat, no-repeat, no-repeat");
  });

  it("anchors the chrome band to the caret bottom, not the lagging lineBottom", () => {
    // Mid-sweep of an earlier line: `state.lineBottom` (the line being swept)
    // sits above the freshly measured last line (`caretBottom`). The band
    // must start at the real last line so the intermediate, not-yet-revealed
    // lines stay hidden.
    const state = createRevealState();
    state.lineTop = 0;
    state.lineBottom = 20;
    state.x = 50;
    const mask = buildRevealMask(state, 80, 100);
    expect(countLayers(mask.maskImage)).toBe(3);
    expect(mask.maskSize).toBe("100% 0px, 100% 20px, 100% 20px");
    expect(mask.maskPosition).toBe("0 0, 0 0px, 0 80px");
  });

  it("omits the band when the chrome height is non-positive", () => {
    const state = createRevealState();
    state.lineTop = 0;
    state.lineBottom = 20;
    state.x = 10;
    // clipBottom below the caret bottom → no band.
    const mask = buildRevealMask(state, 40, 30);
    expect(countLayers(mask.maskImage)).toBe(2);
  });

  it("renders the frontier gradient endpoints from state.x", () => {
    const state = createRevealState();
    state.lineTop = 0;
    state.lineBottom = 20;
    state.x = 120;
    const mask = buildRevealMask(state, 20, 20);
    // FADE_WIDTH is 48, so the gradient ramps from 72px → 120px.
    expect(mask.maskImage).toContain(
      "linear-gradient(to right, #000 72px, transparent 120px)",
    );
  });
});

const stubRect = (el: Element, bottom: number): void => {
  el.getBoundingClientRect = () =>
    ({
      bottom,
      top: 0,
      left: 0,
      right: 0,
      width: 0,
      height: bottom,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
};

describe("findCodeBlockBottom", () => {
  it("resolves to the OUTER streamdown card, not the inner <pre>", () => {
    const container = document.createElement("div");
    const card = document.createElement("div");
    card.setAttribute("data-streamdown", "code-block");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const text = document.createTextNode("const x = 1;");
    code.appendChild(text);
    pre.appendChild(code);
    card.appendChild(pre);
    container.appendChild(card);
    document.body.appendChild(container);

    stubRect(pre, 100); // inner pre bottom
    stubRect(card, 117); // outer card extends ~17px lower (padding + border)

    // Must use the card's bottom (117), container-relative (− 10) = 107.
    // The old `closest('[…], pre')` union would have returned the pre → 90.
    expect(findCodeBlockBottom(text, container, 10)).toBe(107);
  });

  it("falls back to a bare <pre> for code not wrapped in a card", () => {
    const container = document.createElement("div");
    const pre = document.createElement("pre");
    const text = document.createTextNode("indented code");
    pre.appendChild(text);
    container.appendChild(pre);
    document.body.appendChild(container);

    stubRect(pre, 60);
    expect(findCodeBlockBottom(text, container, 5)).toBe(55);
  });

  it("returns null for plain prose with no code-block ancestor", () => {
    const container = document.createElement("div");
    const p = document.createElement("p");
    const text = document.createTextNode("just prose");
    p.appendChild(text);
    container.appendChild(p);
    document.body.appendChild(container);

    expect(findCodeBlockBottom(text, container, 0)).toBeNull();
  });

  it("returns null when the matched block is outside the container", () => {
    const card = document.createElement("div");
    card.setAttribute("data-streamdown", "code-block");
    const text = document.createTextNode("x");
    card.appendChild(text);
    document.body.appendChild(card);

    // Unrelated container that does not contain the card.
    const container = document.createElement("div");
    document.body.appendChild(container);

    expect(findCodeBlockBottom(text, container, 0)).toBeNull();
  });

  it("walks up from an element node (not just a text node)", () => {
    const container = document.createElement("div");
    const card = document.createElement("div");
    card.setAttribute("data-streamdown", "code-block");
    const pre = document.createElement("pre");
    const span = document.createElement("span");
    pre.appendChild(span);
    card.appendChild(pre);
    container.appendChild(card);
    document.body.appendChild(container);

    stubRect(card, 70);
    expect(findCodeBlockBottom(span, container, 20)).toBe(50);
  });
});
