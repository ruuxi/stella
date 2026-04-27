import { useEffect, useState } from "react";
import type { SelfModHmrState } from "../shared/contracts/boundary";

const COVERED_PHASES: ReadonlySet<SelfModHmrState["phase"]> = new Set([
  "morph-forward",
  "applying",
  "reloading",
  "morph-reverse",
]);

/**
 * Renders an invisible click + key absorber while the morph cover is up in the
 * overlay window. Without this, mouse and keyboard events pass through to the
 * main window's DOM — which has just been reshuffled by HMR while the user was
 * still looking at the frozen pre-morph screenshot. That delivers phantom
 * clicks and keystrokes to whatever element happens to occupy the old visual
 * coordinates in the new layout.
 *
 * Only active during phases where the overlay is visually covering the
 * window; `idle` and `paused` leave the UI live and interactive.
 */
export function MorphInputAbsorber() {
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    const off = window.electronAPI?.agent.onSelfModHmrState((state) => {
      setCovered(COVERED_PHASES.has(state.phase));
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!covered) return;
    const block = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", block, { capture: true });
    window.addEventListener("keypress", block, { capture: true });
    window.addEventListener("keyup", block, { capture: true });
    return () => {
      window.removeEventListener("keydown", block, { capture: true });
      window.removeEventListener("keypress", block, { capture: true });
      window.removeEventListener("keyup", block, { capture: true });
    };
  }, [covered]);

  if (!covered) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483646,
        background: "transparent",
        pointerEvents: "auto",
        cursor: "wait",
      }}
    />
  );
}
