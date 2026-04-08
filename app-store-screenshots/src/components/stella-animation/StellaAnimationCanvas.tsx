"use client";

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { BIRTH_DURATION, buildGlyphAtlas, parseColor } from "./glyph-atlas";
import { initRenderer, type GlRenderer } from "./renderer";

const EDGE_SCALE = 2.5;
const TIME_RATE = 0.96;
const LISTENING_ATTACK_LERP = 0.35;
const LISTENING_RELEASE_LERP = 0.14;
const SPEAKING_ATTACK_LERP = 0.18;
const SPEAKING_RELEASE_LERP = 0.12;
const VOICE_ENERGY_ATTACK_RATE = 0.24;
const VOICE_ENERGY_RELEASE_RATE = 0.08;
const FONT_SIZE = 7;
const LINE_HEIGHT = 7;
const FONT_FAMILY =
  '"SF Mono", "Menlo", "Monaco", "Courier New", monospace';

export type VoiceMode = "idle" | "listening" | "speaking";

export interface StellaAnimationCanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
}

type StellaAnimationCanvasProps = {
  width?: number;
  height?: number;
  paused?: boolean;
  manualTime?: number;
  maxDpr?: number;
  frameSkip?: number;
  voiceMode?: VoiceMode;
  initialBirthProgress?: number;
  colors?: readonly [string, string, string, string, string];
};

export const StellaAnimationCanvas = React.forwardRef<
  StellaAnimationCanvasHandle,
  StellaAnimationCanvasProps
>(function StellaAnimationCanvas(
  {
    width = 84,
    height = 42,
    paused = false,
    manualTime,
    maxDpr = 2,
    frameSkip = 0,
    voiceMode = "idle",
    initialBirthProgress = 1,
    colors = [
      "#9ddf72",
      "#6fd7cc",
      "#72b7ff",
      "#b08ef6",
      "#c6ccff",
    ],
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlRenderer | null>(null);
  const requestRef = useRef<number | undefined>(undefined);
  const animateRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  const lastFrameTimeRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const birthRef = useRef<number>(initialBirthProgress);
  const birthAnimationRef = useRef<{
    startTime: number;
    startValue: number;
    duration: number;
  } | null>(null);
  const listeningRef = useRef(0);
  const speakingRef = useRef(0);
  const voiceEnergyRef = useRef(0);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const manualTimeRef = useRef<number | undefined>(manualTime);

  useImperativeHandle(
    ref,
    () => ({
      getCanvas: () => canvasRef.current,
    }),
    [],
  );

  const readColors = useCallback(() => {
    return new Float32Array(colors.flatMap((value) => parseColor(value)));
  }, [colors]);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    manualTimeRef.current = manualTime;
    pausedRef.current = paused || manualTime !== undefined;

    if (
      manualTime === undefined &&
      !paused &&
      !requestRef.current &&
      animateRef.current
    ) {
      requestRef.current = requestAnimationFrame(animateRef.current);
    }
  }, [manualTime, paused]);

  useEffect(() => {
    birthRef.current = initialBirthProgress;
  }, [initialBirthProgress]);

  useEffect(() => {
    rendererRef.current?.setColors(readColors());
  }, [readColors]);

  const computeManualVoiceState = useCallback((sampleTime: number) => {
    const speaking = voiceModeRef.current === "speaking" ? 1 : 0;
    const listening = voiceModeRef.current === "listening" ? 1 : 0;
    const voiceEnergy =
      voiceModeRef.current === "speaking"
        ? 0.36 + Math.max(0, Math.sin(sampleTime * 8.5)) * 0.34
        : voiceModeRef.current === "listening"
          ? 0.18 + Math.max(0, Math.sin(sampleTime * 5.5 + 0.9)) * 0.2
          : 0;

    return { listening, speaking, voiceEnergy };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;

    if (!container || !canvas) {
      return;
    }

    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");

    if (!measureContext) {
      return;
    }

    measureContext.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    const metrics = measureContext.measureText("M");
    const glyphWidth = Math.max(1, Math.ceil(metrics.width));
    const glyphHeight = Math.max(1, Math.ceil(LINE_HEIGHT));
    const cssWidth = Math.max(1, Math.floor(width * glyphWidth * EDGE_SCALE));
    const cssHeight = Math.max(
      1,
      Math.floor(height * glyphHeight * EDGE_SCALE),
    );
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);

    const glyphAtlas = buildGlyphAtlas(
      glyphWidth,
      glyphHeight,
      FONT_FAMILY,
      FONT_SIZE,
    );

    if (!glyphAtlas) {
      return;
    }

    const renderer = initRenderer(
      canvas,
      glyphAtlas,
      width * EDGE_SCALE,
      height * EDGE_SCALE,
      readColors(),
      birthRef.current,
      0,
    );

    if (!renderer) {
      return;
    }

    rendererRef.current = renderer;

    let frameCount = 0;

    const animate = () => {
      if (pausedRef.current) {
        requestRef.current = undefined;
        return;
      }

      const now = performance.now();
      const dt =
        lastFrameTimeRef.current > 0
          ? Math.min(now - lastFrameTimeRef.current, 100)
          : 16.667;
      lastFrameTimeRef.current = now;
      timeRef.current += (dt / 1000) * TIME_RATE;

      if (frameSkip > 0 && ++frameCount % (frameSkip + 1) !== 0) {
        requestRef.current = requestAnimationFrame(animate);
        return;
      }

      const birthAnimation = birthAnimationRef.current;
      if (birthAnimation) {
        const elapsed = now - birthAnimation.startTime;
        const t = Math.min(elapsed / birthAnimation.duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        birthRef.current =
          birthAnimation.startValue + (1 - birthAnimation.startValue) * eased;

        if (t >= 1) {
          birthAnimationRef.current = null;
        }
      }

      const targetListening = voiceModeRef.current === "listening" ? 1 : 0;
      const targetSpeaking = voiceModeRef.current === "speaking" ? 1 : 0;

      const listeningLerp =
        targetListening > listeningRef.current
          ? LISTENING_ATTACK_LERP
          : LISTENING_RELEASE_LERP;
      const speakingLerp =
        targetSpeaking > speakingRef.current
          ? SPEAKING_ATTACK_LERP
          : SPEAKING_RELEASE_LERP;

      listeningRef.current +=
        (targetListening - listeningRef.current) * listeningLerp;
      speakingRef.current +=
        (targetSpeaking - speakingRef.current) * speakingLerp;

      const pulseTime = timeRef.current;
      const rawEnergy =
        voiceModeRef.current === "speaking"
          ? 0.36 + Math.max(0, Math.sin(pulseTime * 8.5)) * 0.34
          : voiceModeRef.current === "listening"
            ? 0.18 + Math.max(0, Math.sin(pulseTime * 5.5 + 0.9)) * 0.2
            : 0;

      const energyRate =
        rawEnergy > voiceEnergyRef.current
          ? VOICE_ENERGY_ATTACK_RATE
          : VOICE_ENERGY_RELEASE_RATE;
      voiceEnergyRef.current +=
        (rawEnergy - voiceEnergyRef.current) * energyRate;

      renderer.render(
        timeRef.current,
        birthRef.current,
        0,
        listeningRef.current,
        speakingRef.current,
        voiceEnergyRef.current,
      );

      requestRef.current = requestAnimationFrame(animate);
    };

    animateRef.current = animate;
    const initialTime = manualTimeRef.current ?? timeRef.current;
    const initialVoiceState = computeManualVoiceState(initialTime);
    renderer.render(
      initialTime,
      birthRef.current,
      0,
      initialVoiceState.listening,
      initialVoiceState.speaking,
      initialVoiceState.voiceEnergy,
    );

    if (!pausedRef.current && manualTimeRef.current === undefined) {
      requestRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }

      animateRef.current = null;
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [computeManualVoiceState, frameSkip, height, maxDpr, readColors, width]);

  useEffect(() => {
    if (manualTime === undefined || !rendererRef.current) {
      return;
    }

    timeRef.current = manualTime;
    const state = computeManualVoiceState(manualTime);
    rendererRef.current.render(
      manualTime,
      birthRef.current,
      0,
      state.listening,
      state.speaking,
      state.voiceEnergy,
    );
  }, [computeManualVoiceState, manualTime, voiceMode]);

  useEffect(() => {
    if (initialBirthProgress >= 1) {
      return;
    }

    birthAnimationRef.current = {
      startTime: performance.now(),
      startValue: initialBirthProgress,
      duration: BIRTH_DURATION,
    };
  }, [initialBirthProgress]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        alignItems: "center",
        justifyContent: "center",
        overflow: "visible",
        background: "transparent",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          imageRendering: "pixelated",
          opacity: 0.98,
        }}
      />
    </div>
  );
});
