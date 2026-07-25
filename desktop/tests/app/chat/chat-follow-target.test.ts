import { describe, expect, it } from "vitest";
import {
  CHAT_VIEWPORT_BOTTOM_FADE_PX,
  FOLLOW_BREATHING_PX,
  FOLLOW_TOP_PEEK_PX,
  POST_SEND_USER_MESSAGE_BREATHING_PX,
  followBottomInsetPx,
  resolveIdleTailTarget,
  resolveLiveTailBottom,
  resolveStreamFollowTarget,
} from "@/shell/chat-follow-target";

const CLIENT_HEIGHT = 800;

/** Bottom of the readable area — everything below is inside the mask fade. */
const readableBottom = CLIENT_HEIGHT - CHAT_VIEWPORT_BOTTOM_FADE_PX;

/** Where `offset` (scroll coordinates) lands on screen at a given scrollTop. */
const onScreen = (offset: number, scrollTop: number) => offset - scrollTop;

/**
 * A mid-stream frame: assistant text ending at 1400, the working indicator
 * as its own item 4px below it (the `.event-list-working-indicator` pad),
 * 36px tall.
 */
const INDICATOR_TOP = 1404;
const INDICATOR_BOTTOM = 1440;
const streamingFrame = {
  clientHeight: CLIENT_HEIGHT,
  rowTop: 1000,
  rowBottom: 1400,
  tailBottom: INDICATOR_BOTTOM,
  unrevealedPx: 0,
  queuedBottom: null,
};

describe("live tail framing", () => {
  it("keeps the working indicator fully clear of the fade with the gutter intact", () => {
    const scrollTop = resolveStreamFollowTarget(streamingFrame);

    const indicatorBottom = onScreen(INDICATOR_BOTTOM, scrollTop);
    expect(indicatorBottom).toBeLessThanOrEqual(readableBottom);
    // The whole indicator, not just its last pixel.
    expect(onScreen(INDICATOR_TOP, scrollTop)).toBeLessThan(readableBottom);
    // And the deliberate breathing space below it actually holds.
    expect(readableBottom - indicatorBottom).toBe(FOLLOW_BREATHING_PX);
  });

  it("would have clipped the indicator when following the row alone", () => {
    // The pre-fix target: streaming row bottom framed against the raw
    // viewport edge. Pinned as a regression guard — this is the screenshot.
    const rowOnly =
      streamingFrame.rowBottom - CLIENT_HEIGHT + FOLLOW_BREATHING_PX;

    expect(onScreen(INDICATOR_BOTTOM, rowOnly)).toBeGreaterThan(readableBottom);
    expect(resolveStreamFollowTarget(streamingFrame)).toBeGreaterThan(rowOnly);
  });

  it("follows a card that mounts below the row mid-stream by exactly its height", () => {
    const before = resolveStreamFollowTarget(streamingFrame);
    const cardHeight = 96;
    const after = resolveStreamFollowTarget({
      ...streamingFrame,
      tailBottom: INDICATOR_BOTTOM + cardHeight,
    });

    expect(after - before).toBe(cardHeight);
    expect(onScreen(INDICATOR_BOTTOM + cardHeight, after)).toBe(
      readableBottom - FOLLOW_BREATHING_PX,
    );
  });

  it("holds back by the row's unrevealed text so the tail never outruns the reveal", () => {
    const unrevealedPx = 40;
    const target = resolveStreamFollowTarget({
      ...streamingFrame,
      // The frontier clamp already pulled `rowBottom` up; the tail below is
      // still laid out past the masked text.
      rowBottom: streamingFrame.rowBottom - unrevealedPx,
      tailBottom: INDICATOR_BOTTOM,
      unrevealedPx,
    });

    expect(target).toBe(resolveStreamFollowTarget(streamingFrame) - unrevealedPx);
  });

  it("never lets a shrinking tail drag the destination back above the row", () => {
    // Indicator vacating (`display: none`) collapses the tail above the row.
    expect(
      resolveLiveTailBottom({
        rowBottom: 1400,
        tailBottom: 1310,
        unrevealedPx: 0,
      }),
    ).toBe(1400);
  });

  it("degrades to the row when the tail cannot be measured", () => {
    expect(
      resolveStreamFollowTarget({ ...streamingFrame, tailBottom: null }),
    ).toBe(streamingFrame.rowBottom - CLIENT_HEIGHT + followBottomInsetPx());
  });

  it("still pins a taller-than-viewport reply to the top instead of chasing it", () => {
    const rowTop = 2000;
    expect(
      resolveStreamFollowTarget({
        ...streamingFrame,
        rowTop,
        rowBottom: rowTop + 3000,
        tailBottom: rowTop + 3040,
      }),
    ).toBe(rowTop - FOLLOW_TOP_PEEK_PX);
  });

  it("leaves the queued follow-up stack on its own tighter framing", () => {
    // The queued stack bottom-aligns inside its own 148px pre-allocated
    // gutter below the indicator, so it sits well past the live tail and its
    // (tighter) target wins the max.
    const queuedBottom = INDICATOR_BOTTOM + 20 + 148 + 40;
    const target = resolveStreamFollowTarget({
      ...streamingFrame,
      queuedBottom,
    });

    expect(target).toBe(
      queuedBottom - CLIENT_HEIGHT + POST_SEND_USER_MESSAGE_BREATHING_PX,
    );
    expect(target).toBeGreaterThan(
      resolveStreamFollowTarget(streamingFrame),
    );
  });

  it("frames idle growth the same way a stream-follow would have", () => {
    const contentBottom = INDICATOR_BOTTOM;
    const target = resolveIdleTailTarget({
      contentBottom,
      clientHeight: CLIENT_HEIGHT,
    });

    expect(readableBottom - onScreen(contentBottom, target)).toBe(
      FOLLOW_BREATHING_PX,
    );
    expect(target).toBe(resolveStreamFollowTarget(streamingFrame));
  });

  it("never returns a negative scrollTop for a short conversation", () => {
    expect(
      resolveStreamFollowTarget({
        clientHeight: CLIENT_HEIGHT,
        rowTop: 10,
        rowBottom: 60,
        tailBottom: 100,
        unrevealedPx: 0,
        queuedBottom: null,
      }),
    ).toBe(0);
    expect(
      resolveIdleTailTarget({ contentBottom: 100, clientHeight: CLIENT_HEIGHT }),
    ).toBe(0);
  });
});
