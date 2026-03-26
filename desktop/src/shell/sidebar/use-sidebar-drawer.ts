import { useCallback, useEffect, useRef, useState } from "react";

const SIDEBAR_WIDTH = 220;
const EDGE_THRESHOLD = 20;
const DIRECTION_LOCK_PX = 8;
const VELOCITY_THRESHOLD = 0.35;
const RUBBER_BAND_FACTOR = 0.3;

function rubberBand(offset: number, max: number): number {
  if (offset <= max) return offset;
  const over = offset - max;
  return max + over * RUBBER_BAND_FACTOR;
}

export function useSidebarDrawer(enabled: boolean) {
  const [isOpen, setIsOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const isOpenRef = useRef(false);

  const gesture = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startOffset: 0,
    currentOffset: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
    directionLock: null as null | "h" | "v",
  });

  const applyTransform = useCallback((offset: number, animated: boolean) => {
    const clamped = rubberBand(Math.max(0, offset), SIDEBAR_WIDTH);
    const progress = Math.min(clamped / SIDEBAR_WIDTH, 1);
    const tx = clamped - SIDEBAR_WIDTH;

    const sidebar = sidebarRef.current;
    const backdrop = backdropRef.current;

    if (sidebar) {
      if (animated) {
        sidebar.style.transition = "transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)";
      } else {
        sidebar.style.transition = "none";
      }
      sidebar.style.transform = `translate3d(${tx}px, 0, 0)`;
      sidebar.style.willChange = animated ? "" : "transform";
    }

    if (backdrop) {
      if (animated) {
        backdrop.style.transition = "opacity 0.35s cubic-bezier(0.32, 0.72, 0, 1)";
      } else {
        backdrop.style.transition = "none";
      }
      backdrop.style.opacity = String(progress * 0.4);
      backdrop.style.pointerEvents = progress > 0.01 ? "auto" : "none";
      backdrop.style.visibility = progress > 0.01 ? "visible" : "hidden";
    }
  }, []);

  const snapTo = useCallback(
    (open: boolean) => {
      const target = open ? SIDEBAR_WIDTH : 0;
      applyTransform(target, true);
      isOpenRef.current = open;
      setIsOpen(open);
    },
    [applyTransform],
  );

  const close = useCallback(() => snapTo(false), [snapTo]);
  const open = useCallback(() => snapTo(true), [snapTo]);
  const toggle = useCallback(
    () => snapTo(!isOpenRef.current),
    [snapTo],
  );

  useEffect(() => {
    if (!enabled) return;

    const g = gesture.current;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;

      const wasOpen = isOpenRef.current;
      const fromEdge = !wasOpen && touch.clientX <= EDGE_THRESHOLD;
      const onSidebar =
        wasOpen && sidebarRef.current?.contains(e.target as Node);
      const onBackdrop =
        wasOpen && backdropRef.current?.contains(e.target as Node);

      if (!fromEdge && !onSidebar && !onBackdrop) return;

      g.active = true;
      g.startX = touch.clientX;
      g.startY = touch.clientY;
      g.startOffset = wasOpen ? SIDEBAR_WIDTH : 0;
      g.currentOffset = g.startOffset;
      g.lastX = touch.clientX;
      g.lastTime = e.timeStamp;
      g.velocity = 0;
      g.directionLock = null;

      // Interrupt any running animation
      if (sidebarRef.current) {
        const computed = getComputedStyle(sidebarRef.current);
        const matrix = new DOMMatrix(computed.transform);
        g.startOffset = matrix.m41 + SIDEBAR_WIDTH;
        g.currentOffset = g.startOffset;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!g.active) return;
      const touch = e.touches[0];
      if (!touch) return;

      const dx = touch.clientX - g.startX;
      const dy = touch.clientY - g.startY;

      // Direction lock
      if (g.directionLock === null) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx < DIRECTION_LOCK_PX && absDy < DIRECTION_LOCK_PX) return;
        g.directionLock = absDx >= absDy ? "h" : "v";
      }

      if (g.directionLock === "v") {
        g.active = false;
        return;
      }

      // Prevent vertical scroll while dragging sidebar
      e.preventDefault();

      const now = e.timeStamp;
      const dt = now - g.lastTime;
      if (dt > 0) {
        g.velocity = (touch.clientX - g.lastX) / dt;
      }
      g.lastX = touch.clientX;
      g.lastTime = now;

      g.currentOffset = g.startOffset + dx;
      applyTransform(g.currentOffset, false);
    };

    const onTouchEnd = () => {
      if (!g.active) return;
      g.active = false;

      const offset = Math.max(0, Math.min(SIDEBAR_WIDTH, g.currentOffset));
      const progress = offset / SIDEBAR_WIDTH;

      // Velocity-based snap
      if (Math.abs(g.velocity) > VELOCITY_THRESHOLD) {
        snapTo(g.velocity > 0);
        return;
      }

      // Position-based snap
      snapTo(progress > 0.5);
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, applyTransform, snapTo]);

  // Initialize position when enabled
  useEffect(() => {
    if (enabled) {
      applyTransform(0, false);
    }
  }, [enabled, applyTransform]);

  return { sidebarRef, backdropRef, isOpen, open, close, toggle };
}
