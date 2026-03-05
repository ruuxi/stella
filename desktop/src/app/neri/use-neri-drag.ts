import { useEffect, useRef, useCallback } from "react";

/**
 * Right-click drag navigation for the Neri strip.
 *
 * - mousedown button===2: start drag
 * - mousemove: apply deltaX to strip.scrollLeft, track velocity
 * - mouseup button===2: end drag, start momentum (friction ~0.95, ~300ms decay)
 * - cumulative deltaY > 80px: switch workspace
 * - contextmenu suppressed when right-click drag was active
 */
export function useNeriDrag(
  stripContainerRef: React.RefObject<HTMLElement | null>,
  switchWorkspace: (delta: number) => void,
) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    cumulativeY: number;
    velocity: number;
    lastX: number;
    lastTime: number;
    workspaceSwitched: boolean;
    wasDrag: boolean;
    strip: HTMLElement;
  } | null>(null);

  const rafRef = useRef<number | null>(null);
  const suppressContextMenu = useRef(false);

  // Cancel any running momentum animation
  const cancelMomentum = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Start momentum after drag ends
  const startMomentum = useCallback((initialVelocity: number) => {
    const strip = stripContainerRef.current?.querySelector(".neri-strip") as HTMLElement | null;
    if (!strip || Math.abs(initialVelocity) < 0.5) return;

    let velocity = initialVelocity;
    const FRICTION = 0.95;

    const animate = () => {
      velocity *= FRICTION;
      if (Math.abs(velocity) < 0.5) {
        rafRef.current = null;
        return;
      }
      strip.scrollLeft -= velocity;
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
  }, [stripContainerRef]);

  useEffect(() => {
    const container = stripContainerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return; // right-click only
      cancelMomentum();

      const strip = container.querySelector(".neri-strip") as HTMLElement | null;
      if (!strip) return;

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: strip.scrollLeft,
        cumulativeY: 0,
        velocity: 0,
        lastX: e.clientX,
        lastTime: performance.now(),
        workspaceSwitched: false,
        wasDrag: false,
        strip,
      };
    };

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const strip = drag.strip;
      const deltaX = e.clientX - drag.startX;
      const deltaY = e.clientY - drag.startY;

      // Mark as a real drag if moved enough
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        drag.wasDrag = true;
      }

      // Horizontal scrolling
      strip.scrollLeft = drag.scrollLeft - deltaX;

      // Track velocity for momentum
      const now = performance.now();
      const dt = now - drag.lastTime;
      if (dt > 0) {
        drag.velocity = (e.clientX - drag.lastX) / dt * 16; // normalize to ~16ms frame
        drag.lastX = e.clientX;
        drag.lastTime = now;
      }

      // Vertical workspace switching
      drag.cumulativeY = deltaY;
      if (!drag.workspaceSwitched && Math.abs(drag.cumulativeY) > 80) {
        drag.workspaceSwitched = true;
        switchWorkspace(drag.cumulativeY > 0 ? 1 : -1);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.wasDrag) {
        suppressContextMenu.current = true;
        startMomentum(drag.velocity);
      }

      dragRef.current = null;
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (suppressContextMenu.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressContextMenu.current = false;
      }
    };

    container.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    container.addEventListener("contextmenu", handleContextMenu);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("contextmenu", handleContextMenu);
      cancelMomentum();
    };
  }, [stripContainerRef, switchWorkspace, cancelMomentum, startMomentum]);
}
