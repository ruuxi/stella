export const HISTORY_START_THRESHOLD_VIEWPORTS = 2;

export type HistoryScrollDirection = "up" | "down" | "none";

export type HistoryPaginationMetrics = {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
};

export type HistoryPaginationGuards = {
  hasMore: boolean;
  isLoading: boolean;
};

export type HistoryPaginationDecision = {
  request: boolean;
  reason:
    | "request"
    | "not-upward"
    | "outside-threshold"
    | "action-consumed"
    | "in-flight"
    | "end-of-history";
  thresholdVisible: boolean;
};

type RequestPhase = "idle" | "awaiting-loading" | "loading";

/**
 * Intent gate for older-history pagination.
 *
 * Legend List intentionally re-fires `onStartReached` when data changes while
 * the start threshold remains visible. That behavior is useful for ordinary
 * feeds, but a prepend turns one chat scroll gesture into a request cascade.
 * This gate makes a user action, rather than content identity, the unit of
 * pagination: an action id can be consumed at most once, and render/layout
 * updates never create an action.
 */
export class ChatHistoryPaginationGate {
  private consumedActionIds = new Set<number>();
  private requestPhase: RequestPhase = "idle";

  syncGuards(guards: HistoryPaginationGuards): {
    requestStarted: boolean;
    requestSettled: boolean;
  } {
    const previous = this.requestPhase;

    // Subscription re-keying briefly reports `hasMore=false` while retaining
    // the prior rows. Loading wins over that transient so the accepted request
    // cannot settle until its larger window actually resolves.
    if (guards.isLoading) {
      this.requestPhase = "loading";
    } else if (this.requestPhase === "loading") {
      this.requestPhase = "idle";
    } else if (!guards.hasMore) {
      this.requestPhase = "idle";
    }

    return {
      requestStarted:
        previous === "awaiting-loading" && this.requestPhase === "loading",
      requestSettled: previous !== "idle" && this.requestPhase === "idle",
    };
  }

  consider(
    actionId: number | null,
    direction: HistoryScrollDirection,
    metrics: HistoryPaginationMetrics,
    guards: HistoryPaginationGuards,
  ): HistoryPaginationDecision {
    this.syncGuards(guards);

    const thresholdVisible =
      metrics.scrollTop <=
      metrics.viewportHeight * HISTORY_START_THRESHOLD_VIEWPORTS;

    if (direction !== "up" || actionId === null) {
      return { request: false, reason: "not-upward", thresholdVisible };
    }
    if (!thresholdVisible) {
      return {
        request: false,
        reason: "outside-threshold",
        thresholdVisible,
      };
    }
    if (this.consumedActionIds.has(actionId)) {
      return {
        request: false,
        reason: "action-consumed",
        thresholdVisible,
      };
    }

    // Consume near-top actions even when a guard blocks them. A wheel burst
    // that overlaps request completion must not become a second request.
    this.consumedActionIds.add(actionId);
    if (this.consumedActionIds.size > 64) {
      const oldest = this.consumedActionIds.values().next().value;
      if (oldest !== undefined) this.consumedActionIds.delete(oldest);
    }

    if (guards.isLoading || this.requestPhase !== "idle") {
      return { request: false, reason: "in-flight", thresholdVisible };
    }
    if (!guards.hasMore) {
      return {
        request: false,
        reason: "end-of-history",
        thresholdVisible,
      };
    }

    // A newly-created upward action is an explicit re-arm even if the user is
    // still within the threshold after the previous prepend. Moving away and
    // approaching again also arrives under a fresh input action; content and
    // measurement updates never manufacture one.
    this.requestPhase = "awaiting-loading";
    return { request: true, reason: "request", thresholdVisible };
  }

  rejectRequest(): void {
    if (this.requestPhase === "awaiting-loading") {
      this.requestPhase = "idle";
    }
  }

  snapshot() {
    return {
      requestPhase: this.requestPhase,
      consumedActionIds: [...this.consumedActionIds],
    };
  }
}

export type ChatPrependAnchor = {
  rowId: string;
  viewportOffset: number;
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
};

const chatRows = (node: HTMLElement): HTMLElement[] =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-chat-row-id]"));

/** Capture the first painted row intersecting the viewport's top edge. */
export const captureChatPrependAnchor = (
  node: HTMLElement,
): ChatPrependAnchor | null => {
  const viewport = node.getBoundingClientRect();
  const rows = chatRows(node)
    .map((candidate) => ({
      candidate,
      rect: candidate.getBoundingClientRect(),
    }))
    .filter(({ rect }) => rect.bottom > viewport.top)
    .sort((a, b) => a.rect.top - b.rect.top);
  // Recycled Legend containers are not guaranteed to remain in visual DOM
  // order, so geometry — not querySelector order — chooses the top anchor.
  const row = rows[0]?.candidate;
  const rowId = row?.dataset.chatRowId;
  if (!row || !rowId) return null;

  return {
    rowId,
    viewportOffset: row.getBoundingClientRect().top - viewport.top,
    scrollTop: node.scrollTop,
    viewportHeight: node.clientHeight,
    contentHeight: node.scrollHeight,
  };
};

export type ChatPrependAnchorRestore = {
  found: boolean;
  adjustment: number;
  scrollTopBefore: number;
  scrollTopAfter: number;
  viewportOffsetAfter: number | null;
  contentHeightAfter: number;
};

/**
 * Correct any residual MVCP error after a prepend. Legend remains the primary
 * anchor owner; this only writes when the captured row's painted viewport
 * offset differs, so an exact MVCP result is a zero-write no-op.
 */
export const restoreChatPrependAnchor = (
  node: HTMLElement,
  anchor: ChatPrependAnchor,
): ChatPrependAnchorRestore => {
  const row = chatRows(node).find(
    (candidate) => candidate.dataset.chatRowId === anchor.rowId,
  );
  const scrollTopBefore = node.scrollTop;
  if (!row) {
    return {
      found: false,
      adjustment: 0,
      scrollTopBefore,
      scrollTopAfter: node.scrollTop,
      viewportOffsetAfter: null,
      contentHeightAfter: node.scrollHeight,
    };
  }

  const viewport = node.getBoundingClientRect();
  const offsetBefore = row.getBoundingClientRect().top - viewport.top;
  const adjustment = offsetBefore - anchor.viewportOffset;
  if (Math.abs(adjustment) > 0.1) node.scrollTop += adjustment;

  const viewportOffsetAfter =
    row.getBoundingClientRect().top - node.getBoundingClientRect().top;
  return {
    found: true,
    adjustment,
    scrollTopBefore,
    scrollTopAfter: node.scrollTop,
    viewportOffsetAfter,
    contentHeightAfter: node.scrollHeight,
  };
};

export type ChatHistoryPaginationDebugEvent = {
  type: string;
  surface: "full" | "compact";
  detail: Record<string, unknown>;
};

/** Opt-in live diagnostics used by the isolated dev harness. */
export const emitChatHistoryPaginationDebug = (
  event: ChatHistoryPaginationDebugEvent,
): void => {
  if (typeof window === "undefined") return;
  const debugWindow = window as Window & {
    __STELLA_CHAT_PAGINATION_DEBUG__?: boolean;
  };
  if (!debugWindow.__STELLA_CHAT_PAGINATION_DEBUG__) return;
  window.dispatchEvent(
    new CustomEvent("stella:chat-history-pagination", { detail: event }),
  );
  console.debug("[chat-history-pagination]", event);
};
