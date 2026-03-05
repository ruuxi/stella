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

export function useScrollManagement({
  itemCount = 0,
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
}: ScrollManagementOptions) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const scrollRafRef = useRef<number | null>(null);
  const prependAnchorRef = useRef<{
    itemCount: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
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
      setIsNearBottom(checkIfNearBottom());
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
      const scrollDelta = container.scrollHeight - anchor.scrollHeight;
      container.scrollTop = anchor.scrollTop + scrollDelta;
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
    showScrollButton,
    scrollToBottom,
    handleScroll,
    resetScrollState,
  };
}
