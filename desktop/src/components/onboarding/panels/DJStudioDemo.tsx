import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════
   Stella Beats — Vertical Step Sequencer
   ═══════════════════════════════════════════════════════════ */

const STEPS = 16;

type Track = {
  name: string;
  shortName: string;
  color: string;
  steps: number[];
  volume: number;
  muted: boolean;
  solo: boolean;
  synth: (ctx: AudioContext, dest: AudioNode, time: number) => void;
};

/* ── Synth functions ── */

function synthKick(ctx: AudioContext, dest: AudioNode, time: number) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(160, time);
  osc.frequency.exponentialRampToValueAtTime(28, time + 0.12);
  g.gain.setValueAtTime(0.8, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.25);
}

function synthSnare(ctx: AudioContext, dest: AudioNode, time: number) {
  const bufSize = ctx.sampleRate * 0.08;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2000;
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(0.5, time);
  gn.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
  src.connect(hp).connect(gn).connect(dest);
  src.start(time);
  const osc = ctx.createOscillator();
  const go = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(200, time);
  osc.frequency.exponentialRampToValueAtTime(100, time + 0.05);
  go.gain.setValueAtTime(0.4, time);
  go.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
  osc.connect(go).connect(dest);
  osc.start(time);
  osc.stop(time + 0.1);
}

function synthHihatClosed(ctx: AudioContext, dest: AudioNode, time: number) {
  const bufSize = ctx.sampleRate * 0.03;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 8000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.3, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  src.connect(hp).connect(g).connect(dest);
  src.start(time);
}

function synthHihatOpen(ctx: AudioContext, dest: AudioNode, time: number) {
  const bufSize = ctx.sampleRate * 0.12;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.35;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.25, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
  src.connect(hp).connect(g).connect(dest);
  src.start(time);
}

function synthClap(ctx: AudioContext, dest: AudioNode, time: number) {
  for (let n = 0; n < 3; n++) {
    const t = time + n * 0.008;
    const bufSize = ctx.sampleRate * 0.02;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2500;
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(bp).connect(g).connect(dest);
    src.start(t);
  }
}

function synthRim(ctx: AudioContext, dest: AudioNode, time: number) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(800, time);
  g.gain.setValueAtTime(0.25, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.03);
}

function synthTom(ctx: AudioContext, dest: AudioNode, time: number) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(240, time);
  osc.frequency.exponentialRampToValueAtTime(100, time + 0.15);
  g.gain.setValueAtTime(0.5, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.2);
}

function synthPerc(ctx: AudioContext, dest: AudioNode, time: number) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, time);
  osc.frequency.exponentialRampToValueAtTime(300, time + 0.06);
  g.gain.setValueAtTime(0.3, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.08);
}

/* ── Patterns ── */

type PatternPreset = { name: string; tracks: Omit<Track, "synth" | "solo">[] };

const SYNTHS = [synthKick, synthSnare, synthHihatClosed, synthHihatOpen, synthClap, synthRim, synthTom, synthPerc];

const PRESETS: PatternPreset[] = [
  {
    name: "Classic",
    tracks: [
      { name: "Kick",   shortName: "KCK", color: "#a855f7", volume: 90, muted: false, steps: [1,0,0,0, 1,0,0,0, 1,0,0,1, 0,0,1,0] },
      { name: "Snare",  shortName: "SNR", color: "#3b82f6", volume: 80, muted: false, steps: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0] },
      { name: "Cl Hat", shortName: "CHH", color: "#22c55e", volume: 65, muted: false, steps: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
      { name: "Op Hat", shortName: "OHH", color: "#10b981", volume: 55, muted: false, steps: [0,0,0,0, 0,0,0,1, 0,0,0,0, 0,0,0,1] },
      { name: "Clap",   shortName: "CLP", color: "#f43f5e", volume: 70, muted: false, steps: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,1] },
      { name: "Rim",    shortName: "RIM", color: "#f59e0b", volume: 50, muted: false, steps: [0,0,1,0, 0,0,0,0, 0,1,0,0, 0,0,0,0] },
      { name: "Tom",    shortName: "TOM", color: "#06b6d4", volume: 70, muted: false, steps: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,1,0,0] },
      { name: "Perc",   shortName: "PRC", color: "#ec4899", volume: 45, muted: false, steps: [0,0,0,1, 0,0,1,0, 0,0,0,1, 0,0,0,0] },
    ],
  },
  {
    name: "Trap",
    tracks: [
      { name: "Kick",   shortName: "KCK", color: "#a855f7", volume: 95, muted: false, steps: [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0] },
      { name: "Snare",  shortName: "SNR", color: "#3b82f6", volume: 85, muted: false, steps: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0] },
      { name: "Cl Hat", shortName: "CHH", color: "#22c55e", volume: 60, muted: false, steps: [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1] },
      { name: "Op Hat", shortName: "OHH", color: "#10b981", volume: 50, muted: false, steps: [0,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0] },
      { name: "Clap",   shortName: "CLP", color: "#f43f5e", volume: 75, muted: false, steps: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0] },
      { name: "Rim",    shortName: "RIM", color: "#f59e0b", volume: 40, muted: false, steps: [0,0,0,0, 0,0,0,1, 0,0,0,0, 0,0,1,0] },
      { name: "Tom",    shortName: "TOM", color: "#06b6d4", volume: 65, muted: false, steps: [0,0,0,0, 0,0,0,0, 0,0,0,1, 0,0,0,0] },
      { name: "Perc",   shortName: "PRC", color: "#ec4899", volume: 40, muted: false, steps: [0,0,1,0, 0,0,0,0, 0,1,0,0, 0,0,0,1] },
    ],
  },
  {
    name: "House",
    tracks: [
      { name: "Kick",   shortName: "KCK", color: "#a855f7", volume: 90, muted: false, steps: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0] },
      { name: "Snare",  shortName: "SNR", color: "#3b82f6", volume: 75, muted: false, steps: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0] },
      { name: "Cl Hat", shortName: "CHH", color: "#22c55e", volume: 55, muted: false, steps: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0] },
      { name: "Op Hat", shortName: "OHH", color: "#10b981", volume: 60, muted: false, steps: [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0] },
      { name: "Clap",   shortName: "CLP", color: "#f43f5e", volume: 80, muted: false, steps: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0] },
      { name: "Rim",    shortName: "RIM", color: "#f59e0b", volume: 45, muted: false, steps: [0,0,0,1, 0,0,0,0, 0,0,0,1, 0,0,0,0] },
      { name: "Tom",    shortName: "TOM", color: "#06b6d4", volume: 60, muted: false, steps: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0] },
      { name: "Perc",   shortName: "PRC", color: "#ec4899", volume: 50, muted: false, steps: [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,1,0] },
    ],
  },
];

function loadPreset(preset: PatternPreset): Track[] {
  return preset.tracks.map((t, i) => ({ ...t, solo: false, synth: SYNTHS[i] }));
}

/* ── Styles ── */

const css = `
  .seq-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding-top: 32px;
    font-family: var(--font-family-sans, "Inter", sans-serif);
    background: transparent;
    color: var(--foreground);
    overflow: hidden;
    user-select: none;
  }
  .seq-root * { box-sizing: border-box; }

  /* ── Header ── */
  .seq-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px 10px;
    flex-shrink: 0;
  }
  .seq-brand {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .seq-logo {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--foreground);
  }
  .seq-logo-sub {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: color-mix(in oklch, var(--foreground) 25%, transparent);
  }
  .seq-transport {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .seq-play {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in oklch, var(--foreground) 12%, transparent);
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
    color: color-mix(in oklch, var(--foreground) 50%, transparent);
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }
  .seq-play:hover {
    border-color: color-mix(in oklch, var(--foreground) 25%, transparent);
    color: var(--foreground);
  }
  .seq-play.active {
    background: #a855f7;
    border-color: #a855f7;
    color: #fff;
    box-shadow: 0 0 20px color-mix(in oklch, #a855f7 35%, transparent);
  }

  /* ── Controls row ── */
  .seq-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 18px 10px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .seq-control-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .seq-control-label {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in oklch, var(--foreground) 30%, transparent);
  }
  .seq-bpm-display {
    font-size: 20px;
    font-weight: 200;
    font-variant-numeric: tabular-nums;
    color: color-mix(in oklch, var(--foreground) 70%, transparent);
    min-width: 36px;
    text-align: right;
  }
  .seq-slider {
    width: 80px;
    height: 3px;
    -webkit-appearance: none;
    appearance: none;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .seq-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: color-mix(in oklch, var(--foreground) 40%, transparent);
    cursor: pointer;
    border: none;
    transition: background 0.12s ease;
  }
  .seq-slider:hover::-webkit-slider-thumb {
    background: color-mix(in oklch, var(--foreground) 65%, transparent);
  }
  .seq-swing-val {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: color-mix(in oklch, var(--foreground) 40%, transparent);
    min-width: 28px;
    text-align: right;
  }

  /* ── Preset tabs ── */
  .seq-presets {
    display: flex;
    gap: 2px;
    padding: 0 18px 10px;
    flex-shrink: 0;
  }
  .seq-preset-btn {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
    background: transparent;
    color: color-mix(in oklch, var(--foreground) 30%, transparent);
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .seq-preset-btn:hover {
    border-color: color-mix(in oklch, var(--foreground) 15%, transparent);
    color: color-mix(in oklch, var(--foreground) 55%, transparent);
  }
  .seq-preset-btn.active {
    border-color: color-mix(in oklch, #a855f7 40%, transparent);
    background: color-mix(in oklch, #a855f7 8%, transparent);
    color: #a855f7;
  }

  /* ── Divider ── */
  .seq-divider {
    height: 1px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    margin: 0 18px;
    flex-shrink: 0;
  }

  /* ── Grid (vertical) ── */
  .seq-grid-area {
    flex: 1;
    overflow: auto;
    scrollbar-width: thin;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Column headers (instrument names) */
  .seq-col-headers {
    display: flex;
    gap: 3px;
    padding-left: 28px;
    padding-bottom: 8px;
    flex-shrink: 0;
  }
  .seq-col-head {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    transition: opacity 0.12s ease;
    position: relative;
  }
  .seq-col-head.muted { opacity: 0.25; }
  .seq-col-head.soloed .seq-col-dot {
    box-shadow: 0 0 8px var(--dot-color);
  }
  .seq-col-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  .seq-col-head:hover .seq-col-dot { transform: scale(1.3); }
  .seq-col-name {
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: color-mix(in oklch, var(--foreground) 40%, transparent);
  }
  .seq-col-badge {
    font-size: 6px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #f59e0b;
    line-height: 1;
  }

  /* Step rows */
  .seq-step-row {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 0;
    flex: 1;
    min-height: 28px;
    position: relative;
  }
  .seq-step-row.bar-start {
    margin-top: 6px;
  }
  .seq-step-row.bar-start::before {
    content: '';
    position: absolute;
    top: -3px;
    left: 28px;
    right: 0;
    height: 1px;
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
  }

  /* Playhead row highlight */
  .seq-step-row.current {
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    border-radius: 4px;
  }

  /* Row number */
  .seq-row-num {
    width: 24px;
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: right;
    padding-right: 6px;
    color: color-mix(in oklch, var(--foreground) 15%, transparent);
  }
  .seq-row-num.downbeat {
    color: color-mix(in oklch, var(--foreground) 35%, transparent);
  }
  .seq-step-row.current .seq-row-num {
    color: color-mix(in oklch, var(--foreground) 55%, transparent);
  }

  /* Individual pad */
  .seq-pad {
    flex: 1;
    height: 100%;
    min-height: 24px;
    border-radius: 3px;
    border: 1px solid color-mix(in oklch, var(--foreground) 5%, transparent);
    background: color-mix(in oklch, var(--foreground) 2%, transparent);
    cursor: pointer;
    transition: background 0.06s ease, border-color 0.06s ease, box-shadow 0.06s ease;
  }
  .seq-pad:hover {
    border-color: color-mix(in oklch, var(--foreground) 12%, transparent);
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
  }
  .seq-pad.on {
    border-color: transparent;
  }
  .seq-pad.on.glow {
    box-shadow: 0 0 10px var(--pad-color-glow);
  }

  /* Volume meters below grid */
  .seq-vol-row {
    display: flex;
    gap: 3px;
    padding-left: 28px;
    padding-top: 10px;
    flex-shrink: 0;
  }
  .seq-vol-cell {
    flex: 1;
    display: flex;
    justify-content: center;
  }
  .seq-vol-track {
    width: 3px;
    height: 20px;
    border-radius: 2px;
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    overflow: hidden;
    display: flex;
    flex-direction: column-reverse;
  }
  .seq-vol-fill {
    width: 100%;
    border-radius: 2px;
    transition: height 0.12s ease;
  }

  /* ── Footer ── */
  .seq-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 18px;
    flex-shrink: 0;
  }
  .seq-footer-stat {
    font-size: 10px;
    font-weight: 500;
    color: color-mix(in oklch, var(--foreground) 25%, transparent);
    font-variant-numeric: tabular-nums;
  }
  .seq-footer-actions {
    display: flex;
    gap: 4px;
  }
  .seq-action {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 5px 10px;
    border-radius: 5px;
    border: 1px solid color-mix(in oklch, var(--foreground) 8%, transparent);
    background: transparent;
    color: color-mix(in oklch, var(--foreground) 35%, transparent);
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .seq-action:hover {
    border-color: color-mix(in oklch, var(--foreground) 18%, transparent);
    color: color-mix(in oklch, var(--foreground) 65%, transparent);
  }
  .seq-action.danger:hover {
    border-color: color-mix(in oklch, #f43f5e 50%, transparent);
    color: #f43f5e;
  }
`;

/* ── Main Component ── */

export default function DJStudio() {
  const [tracks, setTracks] = useState<Track[]>(() => loadPreset(PRESETS[0]));
  const [activePreset, setActivePreset] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [bpm, setBpm] = useState(120);
  const [swing, setSwing] = useState(0); // 0–100
  const audioCtxRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepRef = useRef(0);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const swingRef = useRef(swing);
  swingRef.current = swing;
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;

  const hasSolo = tracks.some((t) => t.solo);

  const ensureAudio = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }
    setPlaying(false);
    setCurrentStep(-1);
    stepRef.current = 0;
  }, []);

  const scheduleNext = useCallback(() => {
    const basMs = (60 / bpmRef.current / 4) * 1000;
    const isOffbeat = stepRef.current % 2 === 1;
    const swingDelay = isOffbeat ? basMs * (swingRef.current / 100) * 0.33 : 0;
    intervalRef.current = setTimeout(() => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const s = stepRef.current % STEPS;
      setCurrentStep(s);
      const currentTracks = tracksRef.current;
      const anySolo = currentTracks.some((t) => t.solo);
      for (const track of currentTracks) {
        const audible = anySolo ? track.solo && !track.muted : !track.muted;
        if (track.steps[s] && audible) {
          const g = ctx.createGain();
          g.gain.value = track.volume / 100;
          g.connect(ctx.destination);
          track.synth(ctx, g, ctx.currentTime);
        }
      }
      stepRef.current++;
      scheduleNext();
    }, basMs + swingDelay);
  }, []);

  const startPlayback = useCallback(() => {
    const ctx = ensureAudio();
    stepRef.current = 0;
    setPlaying(true);
    // Fire first step immediately
    const s = 0;
    setCurrentStep(s);
    const anySolo = tracksRef.current.some((t) => t.solo);
    for (const track of tracksRef.current) {
      const audible = anySolo ? track.solo && !track.muted : !track.muted;
      if (track.steps[s] && audible) {
        const g = ctx.createGain();
        g.gain.value = track.volume / 100;
        g.connect(ctx.destination);
        track.synth(ctx, g, ctx.currentTime);
      }
    }
    stepRef.current = 1;
    scheduleNext();
  }, [ensureAudio, scheduleNext]);

  useEffect(
    () => () => {
      if (intervalRef.current) clearTimeout(intervalRef.current);
      audioCtxRef.current?.close();
    },
    [],
  );

  const togglePlay = useCallback(() => {
    if (playing) stopPlayback();
    else startPlayback();
  }, [playing, stopPlayback, startPlayback]);

  const toggleStep = useCallback((trackIdx: number, stepIdx: number) => {
    setTracks((prev) =>
      prev.map((t, i) =>
        i === trackIdx ? { ...t, steps: t.steps.map((s, j) => (j === stepIdx ? (s ? 0 : 1) : s)) } : t,
      ),
    );
    setActivePreset(-1);
  }, []);

  const toggleMute = useCallback((trackIdx: number) => {
    setTracks((prev) => prev.map((t, i) => (i === trackIdx ? { ...t, muted: !t.muted } : t)));
  }, []);

  const toggleSolo = useCallback((trackIdx: number) => {
    setTracks((prev) => prev.map((t, i) => (i === trackIdx ? { ...t, solo: !t.solo } : t)));
  }, []);

  const clearAll = useCallback(() => {
    setTracks((prev) => prev.map((t) => ({ ...t, steps: Array(STEPS).fill(0) })));
    setActivePreset(-1);
  }, []);

  const selectPreset = useCallback((idx: number) => {
    setTracks(loadPreset(PRESETS[idx]));
    setActivePreset(idx);
  }, []);

  const randomize = useCallback(() => {
    setTracks((prev) =>
      prev.map((t) => ({
        ...t,
        steps: Array.from({ length: STEPS }, () => (Math.random() < 0.25 ? 1 : 0)),
      })),
    );
    setActivePreset(-1);
  }, []);

  const activeCount = tracks.reduce((s, t) => s + t.steps.reduce((a, b) => a + b, 0), 0);

  return (
    <>
      <style>{css}</style>
      <div className="seq-root">
        {/* Header */}
        <div className="seq-header">
          <div className="seq-brand">
            <span className="seq-logo">Stella Beats</span>
            <span className="seq-logo-sub">Step Sequencer</span>
          </div>
          <div className="seq-transport">
            <button className={`seq-play ${playing ? "active" : ""}`} onClick={togglePlay}>
              {playing ? "■" : "▶"}
            </button>
          </div>
        </div>

        {/* Preset selector */}
        <div className="seq-presets">
          {PRESETS.map((p, i) => (
            <button
              key={p.name}
              className={`seq-preset-btn ${activePreset === i ? "active" : ""}`}
              onClick={() => selectPreset(i)}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* Controls: BPM + Swing */}
        <div className="seq-controls">
          <div className="seq-control-group">
            <span className="seq-bpm-display">{bpm}</span>
            <span className="seq-control-label">bpm</span>
            <input
              className="seq-slider"
              type="range"
              min={60}
              max={200}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
          </div>
          <div className="seq-control-group">
            <span className="seq-control-label">swing</span>
            <input
              className="seq-slider"
              type="range"
              min={0}
              max={100}
              value={swing}
              onChange={(e) => setSwing(Number(e.target.value))}
            />
            <span className="seq-swing-val">{swing}%</span>
          </div>
        </div>

        <div className="seq-divider" />

        {/* Grid — vertical: columns = instruments, rows = steps */}
        <div className="seq-grid-area">
          {/* Column headers */}
          <div className="seq-col-headers">
            {tracks.map((t, i) => (
              <div
                key={t.name}
                className={`seq-col-head ${t.muted ? "muted" : ""} ${t.solo ? "soloed" : ""}`}
                onClick={() => toggleMute(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  toggleSolo(i);
                }}
                title={`${t.name} — click: ${t.muted ? "unmute" : "mute"} · right-click: ${t.solo ? "unsolo" : "solo"}`}
                style={{ ["--dot-color" as string]: t.color }}
              >
                <div className="seq-col-dot" style={{ background: t.color }} />
                <span className="seq-col-name">{t.shortName}</span>
                {t.solo && <span className="seq-col-badge">S</span>}
              </div>
            ))}
          </div>

          {/* Step rows */}
          {Array.from({ length: STEPS }, (_, stepIdx) => {
            const isDownbeat = stepIdx % 4 === 0;
            const isCurrent = stepIdx === currentStep;
            return (
              <div
                key={stepIdx}
                className={`seq-step-row ${isCurrent ? "current" : ""} ${isDownbeat && stepIdx > 0 ? "bar-start" : ""}`}
              >
                <span className={`seq-row-num ${isDownbeat ? "downbeat" : ""}`}>{stepIdx + 1}</span>
                {tracks.map((track, trackIdx) => {
                  const on = track.steps[stepIdx];
                  const glow = on && isCurrent;
                  const dimmed = hasSolo && !track.solo;
                  return (
                    <div
                      key={trackIdx}
                      className={`seq-pad ${on ? "on" : ""} ${glow ? "glow" : ""}`}
                      style={{
                        ["--pad-color-glow" as string]: `color-mix(in oklch, ${track.color} 40%, transparent)`,
                        background: on
                          ? `color-mix(in oklch, ${track.color} ${isCurrent ? "45" : "25"}%, transparent)`
                          : undefined,
                        borderColor: on ? `color-mix(in oklch, ${track.color} 30%, transparent)` : undefined,
                        opacity: track.muted ? 0.15 : dimmed ? 0.3 : 1,
                      }}
                      onClick={() => toggleStep(trackIdx, stepIdx)}
                    />
                  );
                })}
              </div>
            );
          })}

          {/* Volume meters */}
          <div className="seq-vol-row">
            {tracks.map((t) => (
              <div key={t.name} className="seq-vol-cell">
                <div className="seq-vol-track">
                  <div
                    className="seq-vol-fill"
                    style={{
                      height: `${t.volume}%`,
                      background: t.color,
                      opacity: t.muted ? 0.15 : hasSolo && !t.solo ? 0.2 : 0.6,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="seq-footer">
          <span className="seq-footer-stat">{activeCount} hits</span>
          <div className="seq-footer-actions">
            <button className="seq-action" onClick={randomize} title="Random pattern">
              Dice
            </button>
            <button className="seq-action" onClick={() => selectPreset(activePreset >= 0 ? activePreset : 0)}>
              Reset
            </button>
            <button className="seq-action danger" onClick={clearAll}>
              Clear
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
