import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useUiState } from "@/providers/ui-state";
import { useVoiceRecording } from "@/hooks/use-voice-recording";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { useWindowType } from "@/hooks/use-window-type";

interface VoiceOverlayProps {
  onTranscript: (text: string) => void;
  style?: CSSProperties;
}

const BAR_COUNT = 30;
const HALF_BARS = BAR_COUNT / 2;
const BAR_GAP = 2;
const MIN_BAR_HEIGHT = 2;

const SMOOTH_UP = 0.12;
const SMOOTH_DOWN = 0.06;

const SWATCH_CLASSES = ["char-dark", "char-medium-dark", "char-medium", "char-bright", "char-brightest"];
const FALLBACK_COLORS = ["#8888aa", "#9999bb", "#aaaacc", "#88cc88", "#ccaa44"];

function readSwatchColors(container: HTMLElement | null): string[] {
  if (!container) return FALLBACK_COLORS;
  return SWATCH_CLASSES.map((cls, i) => {
    const el = container.querySelector<HTMLSpanElement>(`.${cls}`);
    if (!el) return FALLBACK_COLORS[i];
    return getComputedStyle(el).color || FALLBACK_COLORS[i];
  });
}

function colorForBar(index: number, colors: string[]): string {
  const t = index / (HALF_BARS - 1);
  const ci = Math.min(Math.floor(t * colors.length), colors.length - 1);
  return colors[ci];
}

/**
 * Compute overall RMS energy from frequency data, then distribute it
 * across bars with per-bar phase-shifted sine waves for organic variation.
 */
function computeBarAmplitudes(
  dataArray: Uint8Array | null,
  time: number,
): Float32Array {
  const out = new Float32Array(HALF_BARS);

  let energy = 0;
  if (dataArray && dataArray.length > 0) {
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] ?? 0) / 255;
      sum += v * v;
    }
    energy = Math.sqrt(sum / dataArray.length);
  }

  for (let i = 0; i < HALF_BARS; i++) {
    const t = i / (HALF_BARS - 1);

    const wave1 = Math.sin(time * 2.4 + i * 0.9) * 0.5 + 0.5;
    const wave2 = Math.sin(time * 1.7 + i * 1.4 + 2.0) * 0.5 + 0.5;
    const wave3 = Math.sin(time * 3.1 + i * 0.6 + 4.5) * 0.5 + 0.5;
    const organic = (wave1 * 0.5 + wave2 * 0.3 + wave3 * 0.2);

    let freqHint = 0;
    if (dataArray && dataArray.length > 0) {
      const binCenter = Math.floor(t * (dataArray.length * 0.6));
      const binRadius = Math.max(4, Math.floor(dataArray.length * 0.08));
      let binSum = 0;
      let binCount = 0;
      for (let b = binCenter - binRadius; b <= binCenter + binRadius; b++) {
        if (b >= 0 && b < dataArray.length) {
          binSum += (dataArray[b] ?? 0) / 255;
          binCount++;
        }
      }
      freqHint = binCount > 0 ? binSum / binCount : 0;
    }

    const centerBoost = 1.0 - t * 0.5;
    const amplitude = energy * centerBoost * (0.4 + organic * 0.6) * 0.85 + freqHint * 0.15;
    out[i] = amplitude;
  }

  return out;
}

/** Drives the canvas visualizer animation loop. Separated from VoiceOverlay to isolate imperative canvas logic. */
function useVoiceVisualization(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  swatchContainerRef: React.RefObject<HTMLElement | null>,
  analyserRef: React.RefObject<AnalyserNode | null>,
  active: boolean,
) {
  const smoothedRef = useRef<Float32Array | null>(null);
  const colorsRef = useRef<string[]>(FALLBACK_COLORS);

  // Read colors on activation + watch for theme changes
  useEffect(() => {
    if (!active) return;
    colorsRef.current = readSwatchColors(swatchContainerRef.current);

    const observer = new MutationObserver(() => {
      colorsRef.current = readSwatchColors(swatchContainerRef.current);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, [active, swatchContainerRef]);

  // Animation loop
  useEffect(() => {
    if (!active) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.scale(dpr, dpr);

    const cw = rect.width;
    const ch = rect.height;

    if (!smoothedRef.current || smoothedRef.current.length !== HALF_BARS) {
      smoothedRef.current = new Float32Array(HALF_BARS);
    }

    let time = Math.random() * 100;
    let rafId: number;

    const draw = () => {
      ctx.clearRect(0, 0, cw, ch);
      time += 0.016;

      const analyser = analyserRef.current;
      const dataArray = analyser
        ? new Uint8Array(analyser.frequencyBinCount)
        : null;
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
      }

      const raw = computeBarAmplitudes(dataArray, time);
      const smoothed = smoothedRef.current!;
      const colors = colorsRef.current;
      const barWidth = (cw - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
      const centerX = cw / 2;

      const breath = Math.sin(time * 1.2) * 0.5 + 0.5;

      for (let i = 0; i < HALF_BARS; i++) {
        const target = raw[i];
        const rate = target > smoothed[i] ? SMOOTH_UP : SMOOTH_DOWN;
        smoothed[i] += (target - smoothed[i]) * rate;

        const maxBarH = ch - 6;
        const idleH = MIN_BAR_HEIGHT + breath * 1.5 * Math.sin(time * 1.5 + i * 0.5) * 0.5 + 1;
        const barH = Math.max(idleH, smoothed[i] * maxBarH);

        const color = colorForBar(i, colors);
        const y = (ch - barH) / 2;

        const rx = centerX + i * (barWidth + BAR_GAP);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(rx, y, barWidth, barH, barWidth / 2);
        ctx.fill();

        const lx = centerX - (i + 1) * (barWidth + BAR_GAP);
        ctx.beginPath();
        ctx.roundRect(lx, y, barWidth, barH, barWidth / 2);
        ctx.fill();
      }

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [active, canvasRef, analyserRef]);
}

export function VoiceOverlay({ onTranscript, style }: VoiceOverlayProps) {
  const { state, updateState } = useUiState();
  const [showOverlay, setShowOverlay] = useState(false);
  const [exiting, setExiting] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const swatchContainerRef = useRef<HTMLDivElement>(null);

  const windowType = useWindowType();
  const isActiveWindow = windowType === "overlay" || state.window === windowType;

  // STT mode
  const { analyserRef: sttAnalyserRef, isRecording } = useVoiceRecording({
    isActive: isActiveWindow && state.isVoiceActive,
    onTranscript,
  });

  // RTC mode
  const { analyserRef: rtcAnalyserRef, isConnected } = useRealtimeVoice();

  const isAnyVoiceActive = isActiveWindow && (state.isVoiceActive || state.isVoiceRtcActive);
  const isAudioReady = isRecording || isConnected;
  const analyserRef = state.isVoiceRtcActive ? rtcAnalyserRef : sttAnalyserRef;

  // Show/hide with exit animation
  useEffect(() => {
    if (isAnyVoiceActive) {
      setExiting(false);
      setShowOverlay(true);
    } else if (showOverlay) {
      setExiting(true);
      const timer = setTimeout(() => {
        setShowOverlay(false);
        setExiting(false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isAnyVoiceActive, showOverlay]);

  useVoiceVisualization(canvasRef, swatchContainerRef, analyserRef, showOverlay && isAudioReady);

  const handleClick = useCallback(() => {
    if (state.isVoiceRtcActive) {
      updateState({ isVoiceRtcActive: false });
    } else {
      updateState({ isVoiceActive: false });
    }
  }, [state.isVoiceRtcActive, updateState]);

  if (!showOverlay) return null;

  return (
    <div className="voice-overlay" style={style}>
      <div
        className={`voice-overlay-pill${exiting ? " voice-overlay-exiting" : ""}`}
        onClick={handleClick}
      >
        <canvas ref={canvasRef} className="voice-overlay-canvas" />
      </div>

      {/* Hidden swatches to read theme colors via getComputedStyle */}
      <div ref={swatchContainerRef} aria-hidden="true">
        <span className="voice-overlay-swatch char-dark" />
        <span className="voice-overlay-swatch char-medium-dark" />
        <span className="voice-overlay-swatch char-medium" />
        <span className="voice-overlay-swatch char-bright" />
        <span className="voice-overlay-swatch char-brightest" />
      </div>
    </div>
  );
}


