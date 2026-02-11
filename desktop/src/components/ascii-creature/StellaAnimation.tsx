import React, { useEffect, useImperativeHandle, useRef } from "react";
import "../StellaAnimation.css";
import {
  BIRTH_DURATION,
  FLASH_DURATION,
  buildGlyphAtlas,
  getCssNumber,
  parseColor,
} from "./glyph-atlas";
import { initRenderer } from "./renderer";

export interface StellaAnimationHandle {
  triggerFlash: () => void;
  startBirth: () => void;
  reset: (value?: number) => void;
}

interface StellaAnimationProps {
  width?: number;
  height?: number;
  initialBirthProgress?: number;
  paused?: boolean;
}

export const StellaAnimation = React.forwardRef<
  StellaAnimationHandle,
  StellaAnimationProps
>(
  (
    { width = 80, height = 40, initialBirthProgress = 1, paused = false },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const darkRef = useRef<HTMLSpanElement>(null);
    const mediumDarkRef = useRef<HTMLSpanElement>(null);
    const mediumRef = useRef<HTMLSpanElement>(null);
    const brightRef = useRef<HTMLSpanElement>(null);
    const brightestRef = useRef<HTMLSpanElement>(null);
    const requestRef = useRef<number | undefined>(undefined);
    const animateRef = useRef<(() => void) | null>(null);
    const pausedRef = useRef(paused);
    const timeRef = useRef<number>(0);
    const birthRef = useRef<number>(initialBirthProgress);
    const flashRef = useRef<number>(0);
    const birthAnimationRef = useRef<{
      startTime: number;
      startValue: number;
      duration: number;
    } | null>(null);
    const flashAnimationRef = useRef<{
      startTime: number;
      duration: number;
    } | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        triggerFlash: () => {
          flashAnimationRef.current = {
            startTime: performance.now(),
            duration: FLASH_DURATION,
          };
          flashRef.current = 1;
        },
        startBirth: () => {
          if (birthRef.current >= 1) return;
          birthAnimationRef.current = {
            startTime: performance.now(),
            startValue: birthRef.current,
            duration: BIRTH_DURATION,
          };
        },
        reset: (value = initialBirthProgress) => {
          birthRef.current = value;
          birthAnimationRef.current = null;
          flashRef.current = 0;
          flashAnimationRef.current = null;
        },
      }),
      [initialBirthProgress],
    );

    useEffect(() => {
      if (!birthAnimationRef.current) {
        birthRef.current = initialBirthProgress;
      }
    }, [initialBirthProgress]);

    useEffect(() => {
      pausedRef.current = paused;
      if (!paused && !requestRef.current && animateRef.current) {
        requestRef.current = requestAnimationFrame(animateRef.current);
      }
    }, [paused]);

    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;

      const styles = getComputedStyle(container);
      const fontSize = getCssNumber(
        styles.getPropertyValue("--ascii-font-size"),
        11,
      );
      const lineHeight = getCssNumber(
        styles.getPropertyValue("--ascii-line-height"),
        fontSize,
      );
      const fontFamily =
        styles.getPropertyValue("--ascii-font-family").trim() ||
        '"SF Mono", "Menlo", "Monaco", "Courier New", monospace';

      const measureCanvas = document.createElement("canvas");
      const measureCtx = measureCanvas.getContext("2d");
      if (!measureCtx) return;
      measureCtx.font = `${fontSize}px ${fontFamily}`;
      const metrics = measureCtx.measureText("M");
      const glyphWidth = Math.max(1, Math.ceil(metrics.width));
      const glyphHeight = Math.max(1, Math.ceil(lineHeight));

      const cssWidth = Math.max(1, Math.floor(width * glyphWidth));
      const cssHeight = Math.max(1, Math.floor(height * glyphHeight));
      const dpr = window.devicePixelRatio || 1;

      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);

      const glyphAtlas = buildGlyphAtlas(
        fontFamily,
        fontSize,
        glyphWidth,
        glyphHeight,
      );
      if (!glyphAtlas) return;

      const readColors = () => {
        const swatches = [
          darkRef.current,
          mediumDarkRef.current,
          mediumRef.current,
          brightRef.current,
          brightestRef.current,
        ];
        const parsed = swatches.map((el) =>
          parseColor(getComputedStyle(el || container).color),
        );
        return new Float32Array(parsed.flat());
      };

      const mainRenderer = initRenderer(
        canvas,
        glyphAtlas,
        width,
        height,
        readColors(),
        birthRef.current,
        flashRef.current,
      );
      if (!mainRenderer) return;

      const animate = () => {
        if (pausedRef.current) {
          requestRef.current = undefined;
          return;
        }
        timeRef.current += 0.008;
        const now = performance.now();

        const birthAnimation = birthAnimationRef.current;
        if (birthAnimation) {
          const elapsed = now - birthAnimation.startTime;
          const t = Math.min(elapsed / birthAnimation.duration, 1);
          const eased = 1 - Math.pow(1 - t, 3);
          birthRef.current =
            birthAnimation.startValue +
            (1 - birthAnimation.startValue) * eased;
          if (t >= 1) birthAnimationRef.current = null;
        }

        const flashAnimation = flashAnimationRef.current;
        if (flashAnimation) {
          const elapsed = now - flashAnimation.startTime;
          const t = Math.min(elapsed / flashAnimation.duration, 1);
          flashRef.current = 1 - t;
          if (t >= 1) {
            flashRef.current = 0;
            flashAnimationRef.current = null;
          }
        }

        mainRenderer.render(
          timeRef.current,
          birthRef.current,
          flashRef.current,
        );
        requestRef.current = requestAnimationFrame(animate);
      };

      animateRef.current = animate;
      // Always render one initial frame so paused mode shows the creature
      mainRenderer.render(timeRef.current, birthRef.current, flashRef.current);
      if (!pausedRef.current) {
        requestRef.current = requestAnimationFrame(animate);
      }

      const observer = new MutationObserver(() => {
        mainRenderer.setColors(readColors());
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });

      return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        animateRef.current = null;
        observer.disconnect();
        mainRenderer.destroy();
      };
    }, [width, height]);

    return (
      <div ref={containerRef} className="stella-animation-container">
        <canvas ref={canvasRef} className="ascii-canvas" />
        <span
          ref={darkRef}
          className="ascii-color-swatch char-dark"
          aria-hidden="true"
        />
        <span
          ref={mediumDarkRef}
          className="ascii-color-swatch char-medium-dark"
          aria-hidden="true"
        />
        <span
          ref={mediumRef}
          className="ascii-color-swatch char-medium"
          aria-hidden="true"
        />
        <span
          ref={brightRef}
          className="ascii-color-swatch char-bright"
          aria-hidden="true"
        />
        <span
          ref={brightestRef}
          className="ascii-color-swatch char-brightest"
          aria-hidden="true"
        />
      </div>
    );
  },
);
StellaAnimation.displayName = "StellaAnimation";
