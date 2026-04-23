/**
 * SelectionChipOverlay — the "Ask Stella" pill rendered inside the global
 * overlay window when the user finishes selecting text in any foreground
 * app on their computer.
 *
 * Coordinates are overlay-local (already translated by
 * OverlayWindowController.showSelectionChip via overlayOrigin).
 */

import { useEffect, useRef } from "react";
import "./selection-chip-overlay.css";

const PILL_HEIGHT = 28;
const PILL_OFFSET = 8;
const PILL_MIN_WIDTH = 96;
const PILL_VIEWPORT_MARGIN = 6;

export type SelectionChipState = {
  requestId: number;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
};

type SelectionChipOverlayProps = {
  chip: SelectionChipState | null;
  onChipBoundsChange: (
    bounds: { left: number; top: number; width: number; height: number } | null,
  ) => void;
  onClick: (requestId: number) => void;
};

const computePosition = (
  rect: SelectionChipState["rect"],
): { left: number; top: number } => {
  const pillWidth = Math.max(PILL_MIN_WIDTH, rect.width * 0.5);
  const centerX = rect.x + rect.width / 2;
  const left = centerX - pillWidth / 2;
  const naturalTop = rect.y - PILL_HEIGHT - PILL_OFFSET;
  const top =
    naturalTop < PILL_VIEWPORT_MARGIN
      ? rect.y + rect.height + PILL_OFFSET
      : naturalTop;
  return { left, top };
};

export function SelectionChipOverlay({
  chip,
  onChipBoundsChange,
  onClick,
}: SelectionChipOverlayProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!chip) {
      onChipBoundsChange(null);
      return;
    }
    const measure = () => {
      const node = buttonRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      onChipBoundsChange({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      });
    };
    measure();
    const id = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(id);
    };
  }, [chip, onChipBoundsChange]);

  if (!chip) return null;

  const { left, top } = computePosition(chip.rect);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="selection-chip-overlay"
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(chip.requestId);
      }}
      title="Ask Stella about this selection"
    >
      <img
        src="stella-logo.svg"
        alt=""
        aria-hidden="true"
        className="selection-chip-overlay__logo"
      />
      <span className="selection-chip-overlay__label">Ask Stella</span>
    </button>
  );
}
