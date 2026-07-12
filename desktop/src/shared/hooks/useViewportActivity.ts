"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type UseViewportActivityOptions = {
  rootMargin?: string;
};

export function useViewportActivity<T extends HTMLElement>({
  rootMargin = "0px",
}: UseViewportActivityOptions = {}) {
  const ref = useRef<T | null>(null);
  const [isInView, setIsInView] = useState(false);
  const subscribeToDocumentVisibility = useCallback(
    (onStoreChange: () => void) => {
      document.addEventListener("visibilitychange", onStoreChange);
      return () =>
        document.removeEventListener("visibilitychange", onStoreChange);
    },
    [],
  );
  const isDocumentVisible = useSyncExternalStore(
    subscribeToDocumentVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInView(Boolean(entry?.isIntersecting));
      },
      { rootMargin, threshold: 0 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);

  return {
    ref,
    isActive: isInView && isDocumentVisible,
  };
}
