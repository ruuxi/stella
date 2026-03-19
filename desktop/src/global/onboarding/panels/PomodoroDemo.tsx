/**
 * Pomodoro Timer Demo — Focus timer with circular progress, ambient sounds.
 * Built for Stella onboarding creation phase showcase.
 */

import { useState, useEffect, useRef, useCallback } from "react";

const WORK_SECS = 25 * 60;
const BREAK_SECS = 5 * 60;
const RADIUS = 88;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const ACCENT_WORK = "oklch(0.7 0.15 60)";
const ACCENT_BREAK = "oklch(0.65 0.18 155)";

const css = `
  .pomo-root {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: var(--font-family-sans, "Satoshi", sans-serif);
    background: var(--background);
    color: var(--foreground);
    overflow: hidden;
    user-select: none;
    gap: 28px;
    padding: 24px;
    position: relative;
  }
  .pomo-root * { box-sizing: border-box; }

  /* ── Header ── */
  .pomo-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .pomo-title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.04em;
    opacity: 0.85;
  }
  .pomo-subtitle {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    opacity: 0.25;
  }

  /* ── Mode toggle ── */
  .pomo-mode-toggle {
    display: flex;
    gap: 2px;
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
    border-radius: 8px;
    padding: 3px;
  }
  .pomo-mode-btn {
    padding: 6px 18px;
    border-radius: 6px;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--foreground);
    opacity: 0.4;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .pomo-mode-btn[data-active="true"] {
    background: var(--background);
    opacity: 0.9;
    box-shadow: 0 1px 6px color-mix(in oklch, var(--foreground) 8%, transparent);
  }

  /* ── Timer ring ── */
  .pomo-timer-wrap {
    position: relative;
    width: 200px;
    height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pomo-ring-svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .pomo-ring-bg {
    fill: none;
    stroke: color-mix(in oklch, var(--foreground) 5%, transparent);
    stroke-width: 4;
  }
  .pomo-ring-progress {
    fill: none;
    stroke-width: 4;
    stroke-linecap: round;
    transition: stroke-dashoffset 1s linear, stroke 0.4s ease;
  }
  .pomo-ring-glow {
    fill: none;
    stroke-width: 8;
    stroke-linecap: round;
    filter: blur(6px);
    opacity: 0.25;
    transition: stroke-dashoffset 1s linear, stroke 0.4s ease;
  }
  .pomo-time-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    z-index: 1;
  }
  .pomo-time {
    font-size: 44px;
    font-weight: 200;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
    line-height: 1;
    opacity: 0.9;
  }
  .pomo-mode-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.35;
  }

  /* ── Controls ── */
  .pomo-controls {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .pomo-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    color: color-mix(in oklch, var(--foreground) 45%, transparent);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    font-family: inherit;
    padding: 0;
  }
  .pomo-btn:hover {
    border-color: color-mix(in oklch, var(--foreground) 20%, transparent);
    color: var(--foreground);
  }
  .pomo-btn-primary {
    width: 52px;
    height: 52px;
    border: none;
    color: white;
    box-shadow: 0 4px 16px color-mix(in oklch, var(--pomo-accent) 30%, transparent);
    transition: all 0.2s ease;
  }
  .pomo-btn-primary:hover {
    box-shadow: 0 6px 24px color-mix(in oklch, var(--pomo-accent) 40%, transparent);
    transform: scale(1.04);
  }
  .pomo-btn-primary:active {
    transform: scale(0.96);
  }

  /* ── Session dots ── */
  .pomo-sessions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pomo-session-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    transition: all 0.25s ease;
  }
  .pomo-session-dot.completed {
    border-color: var(--pomo-accent);
    background: var(--pomo-accent);
  }
  .pomo-session-dot.current {
    border-color: var(--pomo-accent);
    box-shadow: 0 0 8px color-mix(in oklch, var(--pomo-accent) 35%, transparent);
    animation: pomoDotPulse 2s ease-in-out infinite;
  }
  @keyframes pomoDotPulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--pomo-accent) 30%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in oklch, var(--pomo-accent) 0%, transparent); }
  }
  .pomo-sessions-label {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.25;
    margin-left: 4px;
  }

  /* ── Ambient sounds ── */
  .pomo-ambient {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .pomo-ambient-label {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.25;
  }
  .pomo-ambient-row {
    display: flex;
    gap: 6px;
  }
  .pomo-ambient-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    border-radius: 6px;
    border: 1px solid color-mix(in oklch, var(--foreground) 8%, transparent);
    background: transparent;
    font-family: inherit;
    font-size: 11px;
    font-weight: 400;
    color: var(--foreground);
    opacity: 0.35;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .pomo-ambient-btn:hover {
    opacity: 0.6;
    border-color: color-mix(in oklch, var(--foreground) 16%, transparent);
  }
  .pomo-ambient-btn[data-active="true"] {
    opacity: 0.85;
    background: color-mix(in oklch, var(--pomo-accent) 8%, transparent);
    border-color: color-mix(in oklch, var(--pomo-accent) 22%, transparent);
  }

  /* ── Footer ── */
  .pomo-footer {
    position: absolute;
    bottom: 12px;
    left: 16px;
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.15;
  }
`;

const AMBIENT_SOUNDS = [
  { id: "rain", label: "Rain" },
  { id: "fire", label: "Fireplace" },
  { id: "forest", label: "Forest" },
];

export function PomodoroDemo() {
  const [mode, setMode] = useState<"work" | "break">("work");
  const [timeLeft, setTimeLeft] = useState(WORK_SECS);
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState(0);
  const [ambientActive, setAmbientActive] = useState<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalTime = mode === "work" ? WORK_SECS : BREAK_SECS;
  const progress = 1 - timeLeft / totalTime;
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const accent = mode === "work" ? ACCENT_WORK : ACCENT_BREAK;

  const switchMode = useCallback((next: "work" | "break") => {
    setMode(next);
    setTimeLeft(next === "work" ? WORK_SECS : BREAK_SECS);
    setRunning(false);
  }, []);

  const toggleAmbient = useCallback((id: string) => {
    setAmbientActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!running) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setRunning(false);
          if (mode === "work") {
            setSessions((s) => s + 1);
            setMode("break");
            return BREAK_SECS;
          }
          setMode("work");
          return WORK_SECS;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running, mode]);

  useEffect(
    () => () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    },
    [],
  );

  return (
    <>
      <style>{css}</style>
      <div className="pomo-root" style={{ "--pomo-accent": accent } as React.CSSProperties}>
        <div className="pomo-header">
          <div className="pomo-title">Stella Focus</div>
          <div className="pomo-subtitle">Pomodoro Timer</div>
        </div>

        <div className="pomo-mode-toggle">
          <button className="pomo-mode-btn" data-active={mode === "work"} onClick={() => switchMode("work")}>Work</button>
          <button className="pomo-mode-btn" data-active={mode === "break"} onClick={() => switchMode("break")}>Break</button>
        </div>

        <div className="pomo-timer-wrap">
          <svg className="pomo-ring-svg" viewBox="0 0 200 200">
            <circle className="pomo-ring-bg" cx="100" cy="100" r={RADIUS} />
            <circle
              className="pomo-ring-glow"
              cx="100" cy="100" r={RADIUS}
              stroke={accent}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
            <circle
              className="pomo-ring-progress"
              cx="100" cy="100" r={RADIUS}
              stroke={accent}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          </svg>
          <div className="pomo-time-inner">
            <div className="pomo-time">
              {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
            </div>
            <div className="pomo-mode-label">{mode === "work" ? "Focus time" : "Take a break"}</div>
          </div>
        </div>

        <div className="pomo-controls">
          <button
            className="pomo-btn"
            onClick={() => { setRunning(false); setTimeLeft(mode === "work" ? WORK_SECS : BREAK_SECS); }}
            title="Reset"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          <button
            className="pomo-btn pomo-btn-primary"
            style={{ background: accent }}
            onClick={() => setRunning((r) => !r)}
          >
            {running ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="7 4 20 12 7 20 7 4" />
              </svg>
            )}
          </button>
          <button
            className="pomo-btn"
            onClick={() => switchMode(mode === "work" ? "break" : "work")}
            title="Skip"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 4 15 12 5 20 5 4" fill="currentColor" opacity="0.4" />
              <line x1="19" y1="5" x2="19" y2="19" />
            </svg>
          </button>
        </div>

        <div className="pomo-sessions">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className={`pomo-session-dot ${i < sessions ? "completed" : ""} ${i === sessions ? "current" : ""}`}
            />
          ))}
          <span className="pomo-sessions-label">Sessions</span>
        </div>

        <div className="pomo-ambient">
          <div className="pomo-ambient-label">Ambient Sounds</div>
          <div className="pomo-ambient-row">
            {AMBIENT_SOUNDS.map((s) => (
              <button
                key={s.id}
                className="pomo-ambient-btn"
                data-active={ambientActive.has(s.id)}
                onClick={() => toggleAmbient(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <span className="pomo-footer">Built by Stella</span>
      </div>
    </>
  );
}
