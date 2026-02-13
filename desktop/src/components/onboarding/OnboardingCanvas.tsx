import React, { Suspense, lazy, useState, useEffect, useRef } from "react";
import { Spinner } from "../spinner";

const DJStudioDemo = lazy(() => import("./panels/DJStudioDemo"));
const WeatherStationDemo = lazy(() => import("./panels/WeatherStationDemo"));

export type OnboardingDemo = "dj-studio" | "weather-station" | null;

const ANIM_DURATION = 350;

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({ activeDemo }) => {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const lastDemoRef = useRef<OnboardingDemo>(null);

  if (activeDemo) {
    lastDemoRef.current = activeDemo;
  }

  useEffect(() => {
    if (activeDemo) {
      setClosing(false);
      // Trigger open animation next frame
      requestAnimationFrame(() => setVisible(true));
    } else if (visible) {
      // Trigger close animation
      setClosing(true);
      setVisible(false);
      const timer = setTimeout(() => {
        setClosing(false);
        lastDemoRef.current = null;
      }, ANIM_DURATION);
      return () => clearTimeout(timer);
    }
  }, [activeDemo]);

  const demo = activeDemo || lastDemoRef.current;
  if (!demo && !closing) return null;

  return (
    <div className={`onboarding-canvas ${visible ? "onboarding-canvas-open" : ""} ${closing ? "onboarding-canvas-closing" : ""}`}>
      <Suspense fallback={
        <div className="onboarding-canvas-loading">
          <Spinner />
        </div>
      }>
        {demo === "dj-studio" && <DJStudioDemo />}
        {demo === "weather-station" && <WeatherStationDemo />}
      </Suspense>
    </div>
  );
};
