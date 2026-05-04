import { useEffect, useRef, type CSSProperties } from "react";
import { PREVIEW_STRIP } from "./user-pet-generation";

type PetIdlePreviewProps = {
  /** URL to the 8-frame idle strip WebP. */
  previewUrl: string;
  /** Display size of the rendered frame (square). */
  size?: number;
  /** Loop through idle frames. Pass `false` to render a static cover. */
  animate?: boolean;
  className?: string;
  style?: CSSProperties;
};

const FRAME_DURATIONS_MS = [280, 110, 110, 140, 140, 320, 140, 240];

/**
 * Tiny idle-only preview used by the Pets store grid.
 *
 * Loads a small `previewUrl` (8 frames laid out horizontally) instead
 * of the full atlas spritesheet so the grid stays cheap to render.
 * Animates by mutating `background-position` directly — same pattern
 * as `PetSprite`, just for a 1×8 strip rather than the full 9×8 atlas.
 */
export function PetIdlePreview({
  previewUrl,
  size = 84,
  animate = true,
  className,
  style,
}: PetIdlePreviewProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const totalFrames = PREVIEW_STRIP.frameCount;
    let frame = 0;
    let timer: number | null = null;

    const apply = () => {
      const pct = totalFrames > 1 ? (frame * 100) / (totalFrames - 1) : 0;
      node.style.backgroundPosition = `${pct}% 0%`;
    };
    apply();

    if (!animate || totalFrames <= 1) return;

    const tick = () => {
      const dur = FRAME_DURATIONS_MS[frame] ?? 200;
      timer = window.setTimeout(() => {
        frame = (frame + 1) % totalFrames;
        apply();
        tick();
      }, dur);
    };
    tick();

    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [animate, previewUrl]);

  return (
    <div
      ref={ref}
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${previewUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${PREVIEW_STRIP.frameCount * 100}% 100%`,
        imageRendering: "pixelated",
        ...style,
      }}
    />
  );
}
