/**
 * Shared hooks for the FullShell layout: scroll management, resize observers.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const SCROLL_THRESHOLD = 100;
const TOP_LOAD_THRESHOLD = 48;

type ScrollManagementOptions = {
  itemCount?: number;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
};

type TurnAnchorSnapshot = {
  turnId: string;
  offsetTop: number;
};

type PrependAnchorSnapshot = {
  itemCount: number;
  scrollHeight: number;
  scrollTop: number;
  turnAnchor: TurnAnchorSnapshot | null;
};

const getVisibleTurnAnchor = (
  container: HTMLDivElement,
): TurnAnchorSnapshot | null => {
  if (
    typeof container.querySelectorAll !== "function" ||
    typeof container.getBoundingClientRect !== "function"
  ) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  const turnElements = container.querySelectorAll<HTMLElement>("[data-turn-id]");

  for (const element of turnElements) {
    const turnId = element.dataset.turnId;
    if (!turnId || typeof element.getBoundingClientRect !== "function") {
      continue;
    }

    const elementRect = element.getBoundingClientRect();
    if (
      elementRect.bottom <= containerRect.top ||
      elementRect.top >= containerRect.bottom
    ) {
      continue;
    }

    return {
      turnId,
      offsetTop: elementRect.top - containerRect.top,
    };
  }

  return null;
};

const restoreTurnAnchor = (
  container: HTMLDivElement,
  anchor: TurnAnchorSnapshot,
  baseScrollTop: number,
) => {
  if (
    typeof container.querySelectorAll !== "function" ||
    typeof container.getBoundingClientRect !== "function"
  ) {
    return false;
  }

  const turnElements = container.querySelectorAll<HTMLElement>("[data-turn-id]");
  const anchorElement = Array.from(turnElements).find(
    (element) => element.dataset.turnId === anchor.turnId,
  );

  if (!anchorElement || typeof anchorElement.getBoundingClientRect !== "function") {
    return false;
  }

  const containerRect = container.getBoundingClientRect();
  const currentOffsetTop =
    anchorElement.getBoundingClientRect().top - containerRect.top;

  container.scrollTop = baseScrollTop + (currentOffsetTop - anchor.offsetTop);
  return true;
};

export function useScrollManagement({
  itemCount = 0,
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
}: ScrollManagementOptions) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const prependAnchorRef = useRef<PrependAnchorSnapshot | null>(null);
  const continueLoadingOlderRef = useRef(false);

  const showScrollButton = !isNearBottom;

  const checkIfNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const resetScrollState = useCallback(() => {
    prependAnchorRef.current = null;
    continueLoadingOlderRef.current = false;
    isNearBottomRef.current = true;
    setIsNearBottom(true);
  }, []);

  const maybeLoadOlder = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasOlderEvents || isLoadingOlder || !onLoadOlder) {
      return;
    }
    if (container.scrollTop > TOP_LOAD_THRESHOLD || prependAnchorRef.current) {
      return;
    }

    continueLoadingOlderRef.current = true;
    prependAnchorRef.current = {
      itemCount,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      turnAnchor: getVisibleTurnAnchor(container),
    };
    onLoadOlder();
  }, [hasOlderEvents, isLoadingOlder, itemCount, onLoadOlder]);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = scrollContainerRef.current;
      if (container && container.scrollTop > TOP_LOAD_THRESHOLD) {
        continueLoadingOlderRef.current = false;
      }
      const nearBottom = checkIfNearBottom();
      isNearBottomRef.current = nearBottom;
      setIsNearBottom(nearBottom);
      maybeLoadOlder();
    });
  }, [checkIfNearBottom, maybeLoadOlder]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = prependAnchorRef.current;
    if (!container || !anchor || isLoadingOlder) {
      return;
    }

    if (itemCount > anchor.itemCount) {
      const restoredFromTurn =
        anchor.turnAnchor !== null &&
        restoreTurnAnchor(container, anchor.turnAnchor, anchor.scrollTop);

      if (!restoredFromTurn) {
        const scrollDelta = container.scrollHeight - anchor.scrollHeight;
        container.scrollTop = anchor.scrollTop + scrollDelta;
      }
    }

    prependAnchorRef.current = null;
  }, [isLoadingOlder, itemCount]);

  useEffect(() => {
    if (isLoadingOlder || !continueLoadingOlderRef.current) {
      return;
    }
    maybeLoadOlder();
  }, [isLoadingOlder, itemCount, maybeLoadOlder]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  return {
    scrollContainerRef,
    isNearBottom,
    isNearBottomRef,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    resetScrollState,
  };
}
