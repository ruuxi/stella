import React, { useCallback, useEffect, useRef, useState } from "react";
import { CozyCatDemo } from "./panels/CozyCatDemo";
import { DJStudio } from "./panels/DJStudioDemo";
import { PomodoroDemo } from "./panels/PomodoroDemo";
import { StellaAppMock } from "./panels/StellaAppMock";
import { WeatherStation } from "./panels/WeatherStationDemo";

export type OnboardingDemo =
  | "default"
  | "modern"
  | "dj-studio"
  | "weather-station"
  | "cozy-cat"
  | "pomodoro"
  | null;

/** Delay after React swap to let the new demo paint before revealing it */
const PAINT_SETTLE_MS = 120;
const CSS_MORPH_MS = 450;
const NATIVE_MORPH_RETRY_MS = 80;
const NATIVE_MORPH_MAX_ATTEMPTS = 6;

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
  onMorphStateChange?: (morphing: boolean) => void;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({
  activeDemo,
  onMorphStateChange,
}) => {
  const [displayedDemo, setDisplayedDemo] = useState<OnboardingDemo>(activeDemo);
  const [cssMorphing, setCssMorphing] = useState(false);
  const morphInFlightRef = useRef(false);
  const pendingDemoRef = useRef<OnboardingDemo>(null);

  const wait = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    [],
  );

  const startNativeMorph = useCallback(async () => {
    const morphApi = window.electronAPI?.ui;
    if (typeof morphApi?.morphStart !== "function") {
      return null;
    }

    for (let attempt = 0; attempt < NATIVE_MORPH_MAX_ATTEMPTS; attempt += 1) {
      const started = await morphApi.morphStart();
      if (started?.ok) {
        return morphApi;
      }
      if (attempt < NATIVE_MORPH_MAX_ATTEMPTS - 1) {
        await wait(NATIVE_MORPH_RETRY_MS);
      }
    }

    return null;
  }, [wait]);

  const runMorph = useCallback(
    async (nextDemo: OnboardingDemo) => {
      if (morphInFlightRef.current) {
        pendingDemoRef.current = nextDemo;
        return;
      }
      morphInFlightRef.current = true;
      onMorphStateChange?.(true);

      const morphApi = await startNativeMorph();

      if (morphApi) {
        setDisplayedDemo(nextDemo);
        await wait(PAINT_SETTLE_MS);
        await morphApi.morphComplete();
      } else {
        setCssMorphing(true);
        await new Promise<void>((resolve) => {
          setTimeout(() => setDisplayedDemo(nextDemo), 200);
          setTimeout(resolve, CSS_MORPH_MS);
        });
        setCssMorphing(false);
      }

      morphInFlightRef.current = false;
      onMorphStateChange?.(false);

      const pending = pendingDemoRef.current;
      pendingDemoRef.current = null;
      if (pending !== null && pending !== nextDemo) {
        void runMorph(pending);
      }
    },
    [onMorphStateChange, startNativeMorph, wait],
  );

  useEffect(() => {
    if (activeDemo === displayedDemo) return;

    if (!activeDemo || !displayedDemo) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- direct enter/exit swap is intentional
      setDisplayedDemo(activeDemo);
      return;
    }

    void runMorph(activeDemo);
  }, [activeDemo, displayedDemo, runMorph]);

  if (!displayedDemo) return null;

  return (
    <div
      className={`onboarding-canvas ${cssMorphing ? "onboarding-canvas-morphing" : ""}`}
    >
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
