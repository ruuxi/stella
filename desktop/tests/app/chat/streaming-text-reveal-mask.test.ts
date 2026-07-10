// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRevealState } from "@/app/chat/streaming-text-reveal-frontier";
import {
  buildRevealMask,
  findCodeBlockBottom,
} from "@/app/chat/streaming-text-reveal-mask";

const layerCount = (image: string): number =>
  image.split("linear-gradient").length - 1;

describe("streaming text reveal mask", () => {
  it("builds an opaque-above layer and a 48px soft frontier", () => {
    const state = createRevealState();
    state.lineTop = 10;
    state.lineBottom = 30;
    state.x = 120;

    const mask = buildRevealMask(state, 30, 30);

    expect(layerCount(mask.maskImage)).toBe(2);
    expect(mask.maskImage).toContain(
      "linear-gradient(to right, #000 72px, transparent 120px)",
    );
    expect(mask.maskSize).toBe("100% 10px, 100% 20px");
  });

  it("keeps the outer code-block chrome visible", () => {
    const container = document.createElement("div");
    const card = document.createElement("div");
    card.setAttribute("data-streamdown", "code-block");
    const pre = document.createElement("pre");
    const text = document.createTextNode("const answer = 42;");
    pre.appendChild(text);
    card.appendChild(pre);
    container.appendChild(card);
    card.getBoundingClientRect = () =>
      ({ top: 0, bottom: 75 } as DOMRect);

    expect(findCodeBlockBottom(text, container, 20)).toBe(55);

    const state = createRevealState();
    state.lineTop = 10;
    state.lineBottom = 30;
    state.x = 100;
    expect(layerCount(buildRevealMask(state, 30, 55).maskImage)).toBe(3);
  });
});
