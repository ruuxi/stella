"use client";

import { useEffect, useRef, useState } from "react";

type UseViewportActivityOptions = {
  rootMargin?: string;
};

export function useViewportActivity<T extends HTMLElement>({
  rootMargin = "0px",
}: UseViewportActivityOptions = {}) {
  const ref = useRef<T | null>(null);
  const [isInView, setIsInView] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => {
    if (typeof document === "undefined") {
      return true;
    }

    return document.visibilityState !== "hidden";
  });

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

  useEffect(() => {
    const updateVisibility = () => {
      setIsDocumentVisible(document.visibilityState !== "hidden");
    };

    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  return {
    ref,
    isActive: isInView && isDocumentVisible,
  };
}
