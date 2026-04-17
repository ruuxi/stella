import React, { useCallback, useEffect, useRef, useState } from "react";
import { StellaAppMock } from "./panels/StellaAppMock";
import {
  EMPTY_SECTION_TOGGLES,
  type SectionKey,
  type SectionToggles,
} from "./panels/stella-app-mock-types";

/**
 * OnboardingCanvas — renders the live demo shown during the "creation"
 * onboarding phase.
 *
 * The creation phase shows an interactive `StellaAppMock` whose individual
 * sections (sidebar, header, messages, composer) can each be toggled into a
 * "modern" variant via floating pills rendered on the demo itself. Each
 * toggle is wrapped in the onboarding morph animation: native (Electron IPC)
 * when available, with a CSS blur fallback otherwise — so every change feels
 * like a single "transformation moment".
 */
export type OnboardingDemo = "default" | null;

/** Onboarding-only morph timings — keep in sync with the overlay's morph feel. */
const ONBOARDING_MORPH_PAINT_SETTLE_MS = 200;
/** CSS fallback + `animationDuration` — matches `onboardingMorphFallback` in Onboarding.css. */
const ONBOARDING_MORPH_CSS_DURATION_MS = 400;
const CSS_FALLBACK_SWAP_AT_MS = Math.round(ONBOARDING_MORPH_CSS_DURATION_MS / 2);
const NATIVE_MORPH_RETRY_MS = 80;
const NATIVE_MORPH_MAX_ATTEMPTS = 6;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface OnboardingCanvasProps {
  activeDemo: OnboardingDemo;
}

export const OnboardingCanvas: React.FC<OnboardingCanvasProps> = ({
  activeDemo,
}) => {
  const [toggles, setToggles] =
    useState<SectionToggles>(EMPTY_SECTION_TOGGLES);
  const [cssMorphing, setCssMorphing] = useState(false);
  const morphInFlightRef = useRef(false);
  const pendingToggleRef = useRef<SectionKey | null>(null);

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
  }, []);

  const runMorphRef = useRef<(section: SectionKey) => Promise<void>>(
    async () => {},
  );

  const runMorph = useCallback(
    async (section: SectionKey) => {
      if (morphInFlightRef.current) {
        // Coalesce rapid clicks: keep only the most recent.
        pendingToggleRef.current = section;
        return;
      }

      morphInFlightRef.current = true;

      const applyToggle = () => {
        setToggles((prev) => ({ ...prev, [section]: !prev[section] }));
      };

      const morphApi = await startNativeMorph();

      if (morphApi) {
        applyToggle();
        await wait(ONBOARDING_MORPH_PAINT_SETTLE_MS);
        await morphApi.morphComplete();
      } else {
        setCssMorphing(true);
        await new Promise<void>((resolve) => {
          setTimeout(applyToggle, CSS_FALLBACK_SWAP_AT_MS);
          setTimeout(resolve, ONBOARDING_MORPH_CSS_DURATION_MS);
        });
        setCssMorphing(false);
      }

      morphInFlightRef.current = false;

      const pending = pendingToggleRef.current;
      pendingToggleRef.current = null;
      if (pending !== null) {
        void runMorphRef.current(pending);
      }
    },
    [startNativeMorph],
  );

  useEffect(() => {
    runMorphRef.current = runMorph;
  }, [runMorph]);

  if (!activeDemo) return null;

  return (
    <div
      className={`onboarding-canvas ${cssMorphing ? "onboarding-canvas-morphing" : ""}`}
      style={
        cssMorphing
          ? { animationDuration: `${ONBOARDING_MORPH_CSS_DURATION_MS}ms` }
          : undefined
      }
    >
      <StellaAppMock
        interactive
        toggles={toggles}
        onToggleSection={runMorph}
      />
    </div>
  );
};
