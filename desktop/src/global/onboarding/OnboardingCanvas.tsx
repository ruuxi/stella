import React, { useState, useEffect, useRef, useCallback } from "react";
import { DJStudio } from "./panels/DJStudioDemo";
import { WeatherStation } from "./panels/WeatherStationDemo";
import { CozyCatDemo } from "./panels/CozyCatDemo";
import { StellaAppMock } from "./panels/StellaAppMock";
import { PomodoroDemo } from "./panels/PomodoroDemo";

export type OnboardingDemo = "default" | "modern" | "dj-studio" | "weather-station" | "cozy-cat" | "pomodoro" | null;

/** Delay after React swap to let the new demo paint before capturing */
const PAINT_SETTLE_MS = 120;
const CSS_MORPH_MS = 450;

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
  onMorphStateChange?: (morphing: boolean) => void;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({ activeDemo, onMorphStateChange }) => {
  const [displayedDemo, setDisplayedDemo] = useState<OnboardingDemo>(activeDemo);
  const [cssMorphing, setCssMorphing] = useState(false);
  const morphInFlightRef = useRef(false);
  const pendingDemoRef = useRef<OnboardingDemo>(null);

  const runMorph = useCallback(async (nextDemo: OnboardingDemo) => {
    if (morphInFlightRef.current) {
      pendingDemoRef.current = nextDemo;
      return;
    }
    morphInFlightRef.current = true;
    // Block tile clicks immediately
    onMorphStateChange?.(true);

    const morphApi = window.electronAPI?.ui;
    const canMorph = typeof morphApi?.morphStart === "function";

    if (canMorph) {
      // Electron path — overlay handles visuals, no CSS morph needed
      const started = await morphApi.morphStart();

      if (started?.ok) {
        setDisplayedDemo(nextDemo);
        await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
        await morphApi.morphComplete();
      } else {
        // Overlay failed — fall back to CSS morph
        setCssMorphing(true);
        await new Promise<void>((resolve) => {
          setTimeout(() => setDisplayedDemo(nextDemo), 200);
          setTimeout(resolve, CSS_MORPH_MS);
        });
        setCssMorphing(false);
      }
    } else {
      // No Electron API — CSS fallback
      setCssMorphing(true);
      await new Promise<void>((resolve) => {
        setTimeout(() => setDisplayedDemo(nextDemo), 200);
        setTimeout(resolve, CSS_MORPH_MS);
      });
      setCssMorphing(false);
    }

    morphInFlightRef.current = false;
    onMorphStateChange?.(false);

    // Process any queued request
    const pending = pendingDemoRef.current;
    pendingDemoRef.current = null;
    if (pending !== null && pending !== nextDemo) {
      void runMorph(pending);
    }
  }, [onMorphStateChange]);

  useEffect(() => {
    if (activeDemo === displayedDemo) return;

    if (!activeDemo || !displayedDemo) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- immediate swap on phase enter/exit, no cascading render risk
      setDisplayedDemo(activeDemo);
      return;
    }

    void runMorph(activeDemo);
  }, [activeDemo, displayedDemo, runMorph]);

  if (!displayedDemo) return null;

  return (
    <div className={`onboarding-canvas ${cssMorphing ? "onboarding-canvas-morphing" : ""}`}>
      {(displayedDemo === "default" || displayedDemo === "modern") && (
        <StellaAppMock variant={displayedDemo} />
      )}
      {displayedDemo === "dj-studio" && <DJStudio />}
      {displayedDemo === "weather-station" && <WeatherStation />}
      {displayedDemo === "cozy-cat" && <CozyCatDemo />}
      {displayedDemo === "pomodoro" && <PomodoroDemo />}
    </div>
  );
};
