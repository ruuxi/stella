import React, { useEffect, useImperativeHandle, useRef } from "react";
import "./StellaAnimation.css";
import {
  BIRTH_DURATION,
  FLASH_DURATION,
  buildGlyphAtlas,
  getCssNumber,
  parseColor,
} from "./glyph-atlas";
import { initRenderer } from "./renderer";

/** Reusable buffer for frequency data — avoids per-frame allocation. */
let energyBuffer: Uint8Array<ArrayBuffer> | null = null;

function computeEnergy(analyser: AnalyserNode): number {
  const len = analyser.frequencyBinCount;
  if (!energyBuffer || energyBuffer.length < len) {
    energyBuffer = new Uint8Array(len);
  }
  analyser.getByteFrequencyData(energyBuffer);
  let sum = 0;
  for (let j = 0; j < len; j++) {
    const v = energyBuffer[j] / 255;
    sum += v * v;
  }
  return Math.sqrt(sum / len);
}

/**
 * Extra canvas space around the creature so edge effects (speaking expansion,
 * breathing, flash wave) are never clipped. The shader UV mapping is scaled
 * by the same factor so the creature stays the same pixel size.
 */
const EDGE_SCALE = 2.5;
const NOISE_FLOOR_FAST_RATE = 0.1;
const NOISE_FLOOR_SLOW_RATE = 0.005;
const NOISE_FLOOR_SPEECH_RATIO = 3;
const NOISE_FLOOR_MIN_THRESHOLD = 0.04;
const LISTENING_ATTACK_LERP = 0.35;
const LISTENING_RELEASE_LERP = 0.14;
const SPEAKING_ATTACK_LERP = 0.18;
const SPEAKING_RELEASE_LERP = 0.12;
const VOICE_ENERGY_ATTACK_RATE = 0.24;
const VOICE_ENERGY_RELEASE_RATE = 0.08;

export interface StellaAnimationHandle {
  triggerFlash: () => void;
  startBirth: () => void;
  reset: (value?: number) => void;
}

export type VoiceMode = "idle" | "listening" | "speaking";

interface StellaAnimationProps {
  width?: number;
  height?: number;
  initialBirthProgress?: number;
  paused?: boolean;
  maxDpr?: number;
  frameSkip?: number;
  voiceMode?: VoiceMode;
  isUserSpeaking?: boolean;
  analyserRef?: React.RefObject<AnalyserNode | null>;
  outputAnalyserRef?: React.RefObject<AnalyserNode | null>;
  micLevel?: number;
  outputLevel?: number;
}

export const StellaAnimation = React.forwardRef<
  StellaAnimationHandle,
  StellaAnimationProps
>(
  (
    { width = 80, height = 40, initialBirthProgress = 1, paused = false, maxDpr, frameSkip = 0, voiceMode = "idle", isUserSpeaking = false, analyserRef: externalAnalyserRef, outputAnalyserRef: externalOutputAnalyserRef, micLevel: externalMicLevel, outputLevel: externalOutputLevel },
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
    const listeningRef = useRef(0);
    const speakingRef = useRef(0);
    const voiceEnergyRef = useRef(0);
    const noiseFloorRef = useRef(0);
    const voiceModeRef = useRef<VoiceMode>(voiceMode);
    const isUserSpeakingRef = useRef(isUserSpeaking);
    const externalMicLevelRef = useRef<number | undefined>(externalMicLevel);
    const externalOutputLevelRef = useRef<number | undefined>(externalOutputLevel);

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
      voiceModeRef.current = voiceMode;
    }, [voiceMode]);

    useEffect(() => {
      isUserSpeakingRef.current = isUserSpeaking;
    }, [isUserSpeaking]);

    useEffect(() => {
      externalMicLevelRef.current = externalMicLevel;
    }, [externalMicLevel]);

    useEffect(() => {
      externalOutputLevelRef.current = externalOutputLevel;
    }, [externalOutputLevel]);

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

      const cssWidth = Math.max(1, Math.floor(width * glyphWidth * EDGE_SCALE));
      const cssHeight = Math.max(1, Math.floor(height * glyphHeight * EDGE_SCALE));
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr ?? Infinity);

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
        width * EDGE_SCALE,
        height * EDGE_SCALE,
        readColors(),
        birthRef.current,
        flashRef.current,
      );
      if (!mainRenderer) return;

      let frameCount = 0;

      const animate = () => {
        if (pausedRef.current) {
          requestRef.current = undefined;
          return;
        }
        timeRef.current += 0.008;

        if (frameSkip > 0 && ++frameCount % (frameSkip + 1) !== 0) {
          requestRef.current = requestAnimationFrame(animate);
          return;
        }

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

        // Read analyser refs directly from props (stable ref objects, .current changes)
        const outputAnalyser = externalOutputAnalyserRef?.current ?? null;
        const micAnalyser = externalAnalyserRef?.current ?? null;
        const outputEnergy = typeof externalOutputLevelRef.current === "number"
          ? externalOutputLevelRef.current
          : outputAnalyser
            ? computeEnergy(outputAnalyser)
            : 0;
        const micEnergy = typeof externalMicLevelRef.current === "number"
          ? externalMicLevelRef.current
          : micAnalyser
            ? computeEnergy(micAnalyser)
            : 0;

        const isVoiceActive = voiceModeRef.current !== "idle";

        // Adaptive noise floor: tracks ambient mic level so the listening
        // animation only triggers on actual speech, not background noise.
        if (!isVoiceActive) {
          noiseFloorRef.current = 0;
        } else {
          const floor = noiseFloorRef.current;
          if (micEnergy <= floor || floor === 0) {
            // Fast adapt downward / initialize
            noiseFloorRef.current = floor * (1 - NOISE_FLOOR_FAST_RATE) + micEnergy * NOISE_FLOOR_FAST_RATE;
          } else if (micEnergy < floor * NOISE_FLOOR_SPEECH_RATIO) {
            // Slow adapt upward (ambient drift, not speech)
            noiseFloorRef.current = floor * (1 - NOISE_FLOOR_SLOW_RATE) + micEnergy * NOISE_FLOOR_SLOW_RATE;
          }
          // When micEnergy >= floor * SPEECH_RATIO, don't adapt — it's speech
        }
        const speechThreshold = Math.max(
          noiseFloorRef.current * NOISE_FLOOR_SPEECH_RATIO,
          NOISE_FLOOR_MIN_THRESHOLD,
        );

        // Prefer voiceMode prop (driven by server events) for speaking detection;
        // fall back to energy threshold for non-RTC or when voiceMode is "listening".
        const isSpeakingNow =
          voiceModeRef.current === "speaking" ||
          (isVoiceActive && outputEnergy > 0.08);
        const isListeningNow =
          isVoiceActive &&
          !isSpeakingNow &&
          (isUserSpeakingRef.current || micEnergy > speechThreshold);

        // Smoothly interpolate listening/speaking (0→1)
        const targetListening = isListeningNow ? 1 : 0;
        const targetSpeaking = isSpeakingNow ? 1 : 0;
        const listeningLerp =
          targetListening > listeningRef.current
            ? LISTENING_ATTACK_LERP
            : LISTENING_RELEASE_LERP;
        const speakingLerp =
          targetSpeaking > speakingRef.current
            ? SPEAKING_ATTACK_LERP
            : SPEAKING_RELEASE_LERP;
        listeningRef.current += (targetListening - listeningRef.current) * listeningLerp;
        speakingRef.current += (targetSpeaking - speakingRef.current) * speakingLerp;

        // Voice energy: use output energy when speaking, mic energy when listening
        const rawEnergy = isSpeakingNow
          ? Math.min(outputEnergy * 2.5, 1)
          : Math.min(micEnergy * 2.5, 1);
        const energyRate = rawEnergy > voiceEnergyRef.current
          ? VOICE_ENERGY_ATTACK_RATE
          : VOICE_ENERGY_RELEASE_RATE;
        voiceEnergyRef.current += (rawEnergy - voiceEnergyRef.current) * energyRate;

        mainRenderer.render(
          timeRef.current,
          birthRef.current,
          flashRef.current,
          listeningRef.current,
          speakingRef.current,
          voiceEnergyRef.current,
        );
        requestRef.current = requestAnimationFrame(animate);
      };

      animateRef.current = animate;
      // Always render one initial frame so paused mode shows the creature
      mainRenderer.render(timeRef.current, birthRef.current, flashRef.current, 0, 0, 0);
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
    }, [width, height, externalAnalyserRef, externalOutputAnalyserRef, frameSkip, maxDpr]);

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
