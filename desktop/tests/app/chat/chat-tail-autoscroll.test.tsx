// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";
import {
  beginAssistantScrollFollow,
  clearAssistantScrollFollow,
  notifyChatContentGrowth,
} from "@/shell/chat-scroll-follow";
import {
  FOLLOW_BREATHING_PX,
  followBottomInsetPx,
} from "@/shell/chat-follow-target";

// jsdom ships no `CSS.escape`; the follow lookup builds its selector with it.
if (typeof (globalThis as { CSS?: unknown }).CSS === "undefined") {
  (globalThis as { CSS?: { escape: (value: string) => string } }).CSS = {
    escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
  };
}

const CLIENT_HEIGHT = 800;
const SCROLL_HEIGHT = 2400;
const FOLLOW_KEY = "assistant-turn-1-0";

/** Assistant row occupying 900→1000 in scroll coordinates. */
const ROW_TOP = 900;
const ROW_BOTTOM = 1000;
/**
 * Top of the trailing footer — i.e. the bottom of the live tail. The 200px
 * between it and the row is the working indicator (plus a mid-turn card):
 * content the row-only follow used to leave under the viewport edge.
 */
const TAIL_BOTTOM = 1200;

type Managed = ReturnType<typeof useChatScrollManagement>;

/**
 * jsdom has no layout engine, so the scroll node's geometry is stubbed: real
 * enough for the hook's measurement pass (it reads rects, `clientHeight`,
 * `scrollHeight` and writes `scrollTop`) without pulling in Legend.
 */
function buildScrollNode(): HTMLElement {
  const node = document.createElement("div");
  node.className = "session-content";
  let scrollTop = 0;
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  });
  Object.defineProperty(node, "scrollHeight", {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  });
  node.getBoundingClientRect = () => new DOMRect(0, 0, 600, CLIENT_HEIGHT);
  return node;
}

/** The assistant row carrying the active follow key. */
function appendAssistantRow(node: HTMLElement, streaming: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = `event-row event-row--assistant${streaming ? " event-row--streaming" : ""}`;
  row.setAttribute("data-scroll-follow-key", FOLLOW_KEY);
  Object.defineProperty(row, "offsetHeight", {
    configurable: true,
    get: () => ROW_BOTTOM - ROW_TOP,
  });
  row.getBoundingClientRect = () =>
    new DOMRect(0, ROW_TOP - node.scrollTop, 600, ROW_BOTTOM - ROW_TOP);
  node.appendChild(row);
  return row;
}

/** The footer directly under the live tail — its top is the tail's bottom. */
function appendTrailingRegion(node: HTMLElement): HTMLElement {
  const trailing = document.createElement("div");
  trailing.className = "event-list-trailing-region";
  trailing.getBoundingClientRect = () =>
    new DOMRect(0, TAIL_BOTTOM - node.scrollTop, 600, 160);
  node.appendChild(trailing);
  return trailing;
}

function fakeLegendRef(node: HTMLElement) {
  return {
    getScrollableNode: () => node,
    getState: () => ({
      scroll: node.scrollTop,
      scrollLength: CLIENT_HEIGHT,
      contentLength: SCROLL_HEIGHT,
      isAtEnd: false,
    }),
  };
}

describe("chat tail auto-scroll", () => {
  let container: HTMLDivElement;
  let root: Root;
  let managed: Managed;
  let node: HTMLElement;

  const Harness = () => {
    managed = useChatScrollManagement();
    return null;
  };

  const settle = async (ms = 250) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  /** Run frames until the follow loop stops moving (it eases in, not jumps). */
  const settleFollow = async (timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    let previous = Number.NaN;
    let stableTicks = 0;
    while (Date.now() < deadline && stableTicks < 3) {
      await settle(60);
      stableTicks = node.scrollTop === previous ? stableTicks + 1 : 0;
      previous = node.scrollTop;
    }
  };

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // Pin reduce-motion off so the gentle settle actually animates.
    document.documentElement.setAttribute("data-reduce-motion", "no-preference");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    node = buildScrollNode();
    document.body.appendChild(node);

    await act(async () => {
      root.render(<Harness />);
    });
    managed.listRef.current = fakeLegendRef(node) as never;
    await settle(60);
  });

  afterEach(async () => {
    clearAssistantScrollFollow();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    node.remove();
    document.documentElement.removeAttribute("data-reduce-motion");
  });

  it("follows the bottom of the whole live tail, not just the streaming row", async () => {
    appendAssistantRow(node, true);
    appendTrailingRegion(node);
    beginAssistantScrollFollow(FOLLOW_KEY);
    await settleFollow();

    // Framed on the tail's bottom (indicator + card), clear of the fade band.
    expect(node.scrollTop).toBeCloseTo(
      TAIL_BOTTOM - CLIENT_HEIGHT + followBottomInsetPx(),
      0,
    );
    // The row-only target would have parked the tail 200px off-screen.
    const rowOnly = ROW_BOTTOM - CLIENT_HEIGHT + FOLLOW_BREATHING_PX;
    expect(node.scrollTop).toBeGreaterThan(rowOnly);
    expect(TAIL_BOTTOM - node.scrollTop).toBeLessThan(CLIENT_HEIGHT);
  });

  it("follows a card mounting under an assistant slot that already settled", async () => {
    // The turn is still live (a tool is running, the working indicator is up)
    // but the row has locked, so the keyed follow has nothing to anchor to.
    // The follow key deliberately outlives the row, which used to route this
    // growth into the keyed follow and dead-end there.
    appendAssistantRow(node, false);
    appendTrailingRegion(node);
    beginAssistantScrollFollow(FOLLOW_KEY);
    await settle(80);
    expect(node.scrollTop).toBe(0);

    act(() => {
      notifyChatContentGrowth();
    });
    await settleFollow();

    expect(node.scrollTop).toBeCloseTo(
      TAIL_BOTTOM - CLIENT_HEIGHT + followBottomInsetPx(),
      0,
    );
  });

  it("leaves the gutter above the composer chrome rather than at the raw edge", async () => {
    appendAssistantRow(node, true);
    appendTrailingRegion(node);
    beginAssistantScrollFollow(FOLLOW_KEY);
    await settleFollow();

    // Distance from the tail's bottom to the bottom of the *readable* area.
    const tailOnScreen = TAIL_BOTTOM - node.scrollTop;
    const gutter = CLIENT_HEIGHT - followBottomInsetPx();
    expect(tailOnScreen).toBeCloseTo(gutter, 0);
    expect(CLIENT_HEIGHT - tailOnScreen).toBeGreaterThan(FOLLOW_BREATHING_PX);
  });

  it("stops following after a manual scroll up and does not resume on growth", async () => {
    appendAssistantRow(node, false);
    appendTrailingRegion(node);
    expect(managed.isFollowingLatest).toBe(true);

    await act(async () => {
      node.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
      );
    });
    expect(managed.isFollowingLatest).toBe(false);

    const parked = node.scrollTop;
    beginAssistantScrollFollow(FOLLOW_KEY);
    act(() => {
      notifyChatContentGrowth();
    });
    await settle(400);

    expect(node.scrollTop).toBe(parked);
    expect(managed.isFollowingLatest).toBe(false);
  });

  it("keeps the latch armed when the user scrolls down toward the tail", async () => {
    appendAssistantRow(node, false);
    appendTrailingRegion(node);

    await act(async () => {
      node.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 120, bubbles: true }),
      );
    });
    expect(managed.isFollowingLatest).toBe(true);

    act(() => {
      notifyChatContentGrowth();
    });
    await settleFollow();

    expect(node.scrollTop).toBeGreaterThan(0);
  });
});
