/**
 * Open/close animation for a radial dial, independent of what triggers it.
 *
 * Two surfaces drive dials: the overlay window's, driven by main-process IPC
 * from a global key chord, and the shell's, driven by a right-button press.
 * Both want identical motion, so the spring blob, the phase machine and the
 * content cross-fade live here and each driver only calls `show` and `hide`.
 *
 * Reduced motion collapses the whole thing: the blob is skipped, the phase
 * jumps straight to its resting value and the content appears at once. That has
 * to be handled here rather than in CSS because the motion is a WebGL animation
 * plus inline transitions, neither of which a media query reaches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cssToVec3 } from "@/shared/lib/color";
import {
  RADIAL_DIAL_SIZE,
  RADIAL_WEDGE_COUNT,
} from "@/shared/lib/radial-geometry";
import type { useTheme } from "@/context/theme-context";
import {
  cancelAnimation,
  destroyBlob,
  initBlob,
  primeBlob,
  startClose,
  startOpen,
  type BlobColors,
} from "./radial-blob";

export type RadialDialPhase = "hidden" | "opening" | "open" | "closing";

type ThemeColors = ReturnType<typeof useTheme>["colors"];

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const getBlobColors = (
  colors: ThemeColors,
  selectedIdx: number,
): BlobColors => {
  const cardVec = cssToVec3(colors.card);
  const interactiveVec = cssToVec3(colors.interactive);
  return {
    fills: Array.from({ length: RADIAL_WEDGE_COUNT }, (_, i) =>
      i === selectedIdx ? interactiveVec : cardVec,
    ),
    selectedFill: interactiveVec,
    stroke: cssToVec3(colors.border),
  };
};

export type RadialDialAnimation = {
  phase: RadialDialPhase;
  contentVisible: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** True while motion is suppressed; surfaces drop their transitions too. */
  reducedMotion: boolean;
  show: () => void;
  hide: () => void;
};

export function useRadialDialAnimation({
  colors,
  selectedIndex,
  onCloseComplete,
}: {
  colors: ThemeColors;
  /** Index of the highlighted wedge, or -1 for none. */
  selectedIndex: number;
  /** Fired once the close animation has fully finished. */
  onCloseComplete?: () => void;
}): RadialDialAnimation {
  const [phase, setPhase] = useState<RadialDialPhase>("hidden");
  const [contentVisible, setContentVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blobReady = useRef(false);
  const selectedIdxRef = useRef(selectedIndex);
  const colorsRef = useRef<BlobColors>(getBlobColors(colors, selectedIndex));
  const visibleRef = useRef(false);
  const phaseRef = useRef<RadialDialPhase>("hidden");
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a show/hide pair racing: every transition takes a ticket and
  // stale callbacks from a superseded one drop their results.
  const transitionIdRef = useRef(0);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const onCloseCompleteRef = useRef(onCloseComplete);
  onCloseCompleteRef.current = onCloseComplete;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && !blobReady.current && !reducedMotionRef.current) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = RADIAL_DIAL_SIZE * dpr;
      canvas.height = RADIAL_DIAL_SIZE * dpr;
      blobReady.current = initBlob(canvas);
      if (blobReady.current) {
        // Warm a hidden frame so the first visible open does not stall on the
        // initial WebGL pipeline work.
        primeBlob(colorsRef.current);
      }
    }
    return () => {
      destroyBlob();
      blobReady.current = false;
    };
  }, []);

  useEffect(() => {
    selectedIdxRef.current = selectedIndex;
    colorsRef.current = getBlobColors(colors, selectedIndex);
  }, [colors, selectedIndex]);

  const show = useCallback(() => {
    const transitionId = ++transitionIdRef.current;
    visibleRef.current = true;

    cancelAnimation();
    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }

    // Without the blob — either reduced motion or no WebGL — the dial simply
    // appears. There is nothing to stagger the content behind.
    if (reducedMotionRef.current || !blobReady.current) {
      setPhase("open");
      phaseRef.current = "open";
      setContentVisible(true);
      return;
    }

    setContentVisible(false);
    setPhase("opening");
    phaseRef.current = "opening";

    startOpen(
      selectedIdxRef,
      colorsRef,
      () => {
        if (!visibleRef.current || transitionIdRef.current !== transitionId) {
          return;
        }
        phaseRef.current = "open";
        setPhase("open");
        setContentVisible(true);
      },
      () => {
        if (!visibleRef.current || transitionIdRef.current !== transitionId) {
          return;
        }
        setContentVisible(true);
      },
    );
  }, []);

  const hide = useCallback(() => {
    const transitionId = ++transitionIdRef.current;
    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }
    selectedIdxRef.current = -1;

    const settleHidden = () => {
      visibleRef.current = false;
      setPhase("hidden");
      phaseRef.current = "hidden";
      setContentVisible(false);
      onCloseCompleteRef.current?.();
    };

    if (
      reducedMotionRef.current ||
      !blobReady.current ||
      phaseRef.current === "hidden"
    ) {
      cancelAnimation();
      settleHidden();
      return;
    }

    setPhase("closing");
    phaseRef.current = "closing";

    // The DOM content fades a little ahead of the blob so the wedges are gone
    // before the ring finishes collapsing.
    contentTimerRef.current = setTimeout(() => {
      if (transitionIdRef.current !== transitionId) return;
      contentTimerRef.current = null;
      setContentVisible(false);
    }, 60);

    startClose(selectedIdxRef, colorsRef, () => {
      if (transitionIdRef.current !== transitionId) return;
      settleHidden();
    });
  }, []);

  useEffect(
    () => () => {
      transitionIdRef.current += 1;
      visibleRef.current = false;
      cancelAnimation();
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    },
    [],
  );

  return useMemo(
    () => ({
      phase,
      contentVisible,
      canvasRef,
      reducedMotion,
      show,
      hide,
    }),
    [phase, contentVisible, reducedMotion, show, hide],
  );
}
