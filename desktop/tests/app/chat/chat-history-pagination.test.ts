// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureChatPrependAnchor,
  ChatHistoryPaginationGate,
  restoreChatPrependAnchor,
  type HistoryPaginationMetrics,
} from "@/shell/chat-history-pagination";

const nearTop: HistoryPaginationMetrics = {
  scrollTop: 900,
  viewportHeight: 600,
  contentHeight: 12_000,
};

const guards = { hasMore: true, isLoading: false };

describe("ChatHistoryPaginationGate", () => {
  it("loads exactly one page for the first deliberate upward threshold action", () => {
    const gate = new ChatHistoryPaginationGate();

    expect(
      gate.consider(
        1,
        "up",
        { ...nearTop, scrollTop: 1_300 },
        guards,
      ),
    ).toMatchObject({
      request: false,
      reason: "outside-threshold",
      thresholdVisible: false,
    });

    expect(gate.consider(1, "up", nearTop, guards)).toMatchObject({
      request: true,
      reason: "request",
      thresholdVisible: true,
    });
    expect(gate.consider(1, "up", nearTop, guards)).toMatchObject({
      request: false,
      reason: "action-consumed",
    });
  });

  it("does not re-request when a prepend leaves the threshold visible", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(10, "up", nearTop, guards).request).toBe(true);

    gate.syncGuards({ hasMore: true, isLoading: true });
    gate.syncGuards({ hasMore: true, isLoading: false });

    const stillVisibleAfterPrepend = {
      ...nearTop,
      scrollTop: 1_100,
      contentHeight: 20_000,
    };
    expect(
      gate.consider(10, "up", stillVisibleAfterPrepend, guards),
    ).toMatchObject({ request: false, reason: "action-consumed" });
  });

  it("ignores repeated data/render/measurement updates without user intent", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(20, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });
    gate.syncGuards({ hasMore: true, isLoading: false });

    for (const contentHeight of [13_000, 13_180, 13_160, 13_220]) {
      const decision = gate.consider(
        null,
        "none",
        { ...nearTop, contentHeight },
        guards,
      );
      expect(decision).toMatchObject({
        request: false,
        reason: "not-upward",
      });
    }
  });

  it("allows a second page only for a second deliberate upward action", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(30, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });
    gate.syncGuards({ hasMore: true, isLoading: false });

    expect(gate.consider(31, "up", nearTop, guards)).toMatchObject({
      request: true,
      reason: "request",
    });
  });

  it("dedupes every action that occurs while a page is in flight", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(40, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });

    expect(
      gate.consider(41, "up", nearTop, {
        hasMore: true,
        isLoading: true,
      }),
    ).toMatchObject({ request: false, reason: "in-flight" });

    gate.syncGuards({ hasMore: true, isLoading: false });
    expect(gate.consider(41, "up", nearTop, guards)).toMatchObject({
      request: false,
      reason: "action-consumed",
    });
    expect(gate.consider(42, "up", nearTop, guards).request).toBe(true);
  });

  it("does not settle on the transient hasMore=false subscription re-key", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(45, "up", nearTop, guards).request).toBe(true);
    gate.syncGuards({ hasMore: true, isLoading: true });

    expect(gate.syncGuards({ hasMore: false, isLoading: true })).toMatchObject({
      requestSettled: false,
    });
    expect(gate.snapshot().requestPhase).toBe("loading");
    expect(gate.syncGuards({ hasMore: true, isLoading: false })).toMatchObject({
      requestSettled: true,
    });
  });

  it("stops at end-of-history without entering an in-flight state", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(
      gate.consider(50, "up", nearTop, {
        hasMore: false,
        isLoading: false,
      }),
    ).toMatchObject({ request: false, reason: "end-of-history" });
    expect(gate.snapshot().requestPhase).toBe("idle");
  });

  it("settles an errored request and permits an explicit retry action", () => {
    const gate = new ChatHistoryPaginationGate();
    expect(gate.consider(60, "up", nearTop, guards).request).toBe(true);
    expect(gate.syncGuards({ hasMore: true, isLoading: true })).toMatchObject({
      requestStarted: true,
    });
    expect(gate.syncGuards({ hasMore: true, isLoading: false })).toMatchObject({
      requestSettled: true,
    });

    expect(gate.consider(61, "up", nearTop, guards)).toMatchObject({
      request: true,
      reason: "request",
    });
  });
});

describe("prepend anchor preservation", () => {
  it("restores the exact painted row offset and advances scrollTop by prepend height", () => {
    const viewport = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.chatRowId = "message-200";
    viewport.appendChild(row);
    document.body.appendChild(viewport);

    let rowDocumentTop = 120;
    let contentHeight = 2_000;
    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    Object.defineProperty(viewport, "scrollHeight", {
      get: () => contentHeight,
    });
    viewport.getBoundingClientRect = () =>
      ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({
        top: rowDocumentTop - viewport.scrollTop,
        bottom: rowDocumentTop - viewport.scrollTop + 80,
        height: 80,
      }) as DOMRect;

    const anchor = captureChatPrependAnchor(viewport);
    expect(anchor).toMatchObject({
      rowId: "message-200",
      viewportOffset: 20,
      scrollTop: 100,
      viewportHeight: 600,
      contentHeight: 2_000,
    });

    rowDocumentTop += 500;
    contentHeight += 500;
    const restored = restoreChatPrependAnchor(viewport, anchor!);

    expect(restored).toMatchObject({
      found: true,
      adjustment: 500,
      scrollTopBefore: 100,
      scrollTopAfter: 600,
      viewportOffsetAfter: 20,
      contentHeightAfter: 2_500,
    });
    viewport.remove();
  });

  it("does not write scrollTop when Legend MVCP already preserved the anchor", () => {
    const viewport = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.chatRowId = "message-200";
    viewport.appendChild(row);
    document.body.appendChild(viewport);

    let rowDocumentTop = 120;
    viewport.scrollTop = 100;
    Object.defineProperty(viewport, "clientHeight", { value: 600 });
    Object.defineProperty(viewport, "scrollHeight", { value: 2_500 });
    viewport.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({
        top: rowDocumentTop - viewport.scrollTop,
        bottom: rowDocumentTop - viewport.scrollTop + 80,
      }) as DOMRect;

    const anchor = captureChatPrependAnchor(viewport)!;
    rowDocumentTop += 500;
    viewport.scrollTop += 500;
    const restored = restoreChatPrependAnchor(viewport, anchor);

    expect(restored.adjustment).toBe(0);
    expect(restored.scrollTopBefore).toBe(600);
    expect(restored.scrollTopAfter).toBe(600);
    expect(restored.viewportOffsetAfter).toBe(20);
    viewport.remove();
  });
});

describe("chat timeline pagination wiring", () => {
  it("keeps the native listener performance fix and does not use Legend data-change re-entry", () => {
    const desktopRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const timeline = fs.readFileSync(
      path.join(desktopRoot, "src/app/chat/ChatTimeline.tsx"),
      "utf8",
    );
    const hook = fs.readFileSync(
      path.join(desktopRoot, "src/shell/use-chat-scroll-management.ts"),
      "utf8",
    );

    expect(timeline).not.toMatch(/\bonStartReached=/);
    expect(timeline).not.toContain("onScroll={");
    expect(hook).toMatch(
      /addEventListener\('scroll', handlePaginationScroll, \{\s*passive: true,?\s*\}\)/,
    );
  });
});
