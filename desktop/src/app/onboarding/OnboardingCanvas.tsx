import React, { Suspense, lazy, useState, useEffect } from "react";
import { Spinner } from "@/ui/spinner";

const DJStudioDemo = lazy(() =>
  import("./panels/DJStudioDemo").then((m) => ({ default: m.DJStudio })),
);
const WeatherStationDemo = lazy(() =>
  import("./panels/WeatherStationDemo").then((m) => ({
    default: m.WeatherStation,
  })),
);

export type OnboardingDemo = "dj-studio" | "weather-station" | null;

const ANIM_DURATION = 350;

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({ activeDemo }) => {
  const [renderedDemo, setRenderedDemo] = useState<OnboardingDemo>(activeDemo);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (activeDemo) {
      // Trigger open animation next frame
      const frame = requestAnimationFrame(() => {
        setRenderedDemo(activeDemo);
        setVisible(true);
      });
      return () => cancelAnimationFrame(frame);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close state must be applied immediately to start the exit animation.
    setVisible(false);
  }, [activeDemo]);

  useEffect(() => {
    if (activeDemo || !renderedDemo) {
      return;
    }
    const timer = setTimeout(() => {
      setRenderedDemo(null);
    }, ANIM_DURATION);
    return () => clearTimeout(timer);
  }, [activeDemo, renderedDemo]);

  const demo = activeDemo || renderedDemo;
  const closing = !activeDemo && renderedDemo !== null;

  if (!demo) return null;

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

