import { useEffect, useRef, type CSSProperties } from "react";
import type { PetAnimationState } from "@/shared/contracts/pet";
import {
  formatFramePosition,
  resolveAnimation,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
} from "./sprite-frames";

const usePrefersReducedMotion = (): boolean => {
  const ref = useRef<boolean>(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    ref.current = media.matches;
    const handler = (event: MediaQueryListEvent) => {
      ref.current = event.matches;
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);
  return ref.current;
};

export type PetSpriteProps = {
  /** Spritesheet URL — usually `/pets/<id>.webp` from the built-in manifest. */
  spritesheetUrl: string;
  /** Which animation row to play. Falls back to "idle". */
  state: PetAnimationState;
  /** Pixel size of the rendered frame. Defaults to a 96px square-ish frame. */
  size?: number;
  /** Keep a reactive row looping, used for ongoing voice listening/speaking. */
  continuous?: boolean;
  className?: string;
  style?: CSSProperties;
};

/**
 * Renders one pet, animating its sprite sheet by mutating
 * `background-position` directly on the DOM node.
 *
 * Why direct DOM mutation? React re-renders are unnecessary work on
 * every frame and would invalidate the sprite-sheet's loaded texture
 * across hot-paths (the overlay window also hosts voice / capture /
 * morph surfaces). Codex's pet ships exactly this pattern; we keep it.
 */
export const PetSprite = ({
  spritesheetUrl,
  state,
  size = 96,
  continuous = false,
  className,
  style,
}: PetSpriteProps) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const animation = resolveAnimation(state, prefersReducedMotion, continuous);
    const { frames, loopStartIndex } = animation;
    let frameIndex = 0;
    let timer: number | null = null;

    const apply = () => {
      const frame = frames[frameIndex];
      if (!frame) return;
      node.style.backgroundPosition = formatFramePosition(frame);
    };

    apply();
    if (frames.length === 1) {
      return;
    }

    const tick = () => {
      timer = window.setTimeout(() => {
        const next = frameIndex + 1;
        if (next >= frames.length) {
          if (loopStartIndex != null) {
            frameIndex = loopStartIndex;
            apply();
            tick();
            return;
          }
          timer = null;
          return;
        }
        frameIndex = next;
        apply();
        tick();
      }, frames[frameIndex].frameDurationMs);
    };

    tick();

    return () => {
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [state, prefersReducedMotion, spritesheetUrl, continuous]);

  // Aspect-ratio-locked block (192:208) so the sprite never squashes.
  const computedHeight = Math.round(size * (208 / 192));

  return (
    <div
      ref={ref}
      className={className}
      data-pet-state={state}
      aria-hidden="true"
      style={{
        width: size,
        height: computedHeight,
        backgroundImage: `url(${spritesheetUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${SPRITE_COLUMNS * 100}% ${SPRITE_ROWS * 100}%`,
        imageRendering: "pixelated",
        ...style,
      }}
    />
  );
};
