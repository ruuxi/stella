import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { RouterProvider } from "@tanstack/react-router";
import { PageSidebarProvider } from "@/context/page-sidebar";
import { useTheme } from "@/context/theme-context";
import { useUiState } from "@/context/ui-state";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import {
  SPLIT_STEP_ORDER,
  type Phase as OnboardingPhase,
} from "@/global/onboarding/onboarding-flow";
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import { useOnboardingOverlay } from "@/global/onboarding/use-onboarding-overlay";
import { useBootstrapState } from "@/systems/boot/bootstrap-state";
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { MorphInputAbsorber } from "./MorphInputAbsorber";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import "./full-shell.layout.css";
import "./mobile.css";

/* Onboarding is loaded as a single dynamic chunk that contains the entire
 * flow: every phase component, the StellaAnimation creature, the legal
 * dialog, the demo canvas, and all onboarding CSS. The chunk is preloaded
 * eagerly the moment we know `!appReady` (see useEffect below) so the
 * flow feels synchronous to the user; once it has resolved, every
 * in-flow transition is a normal sync render — there are NO Suspense
 * boundaries below this point.
 *
 * Returning users (`appReady === true` at first paint) never fetch this
 * chunk. After completion the React subtree unmounts and the lazy import
 * is never re-evaluated, so onboarding code is genuinely gone for the
 * remainder of the session and absent from the next cold start. */
const onboardingChunkPromise: { current: Promise<unknown> | null } = {
  current: null,
};
const loadOnboardingChunk = () => {
  if (!onboardingChunkPromise.current) {
    onboardingChunkPromise.current = Promise.all([
      import("@/global/onboarding/OnboardingOverlay"),
      import("@/global/onboarding/OnboardingCanvas"),
    ]);
  }
  return onboardingChunkPromise.current;
};

const OnboardingView = lazy(() =>
  import("@/global/onboarding/OnboardingOverlay").then((module) => ({
    default: module.OnboardingView,
  })),
);
const OnboardingCanvas = lazy(() =>
  import("@/global/onboarding/OnboardingCanvas").then((module) => ({
    default: module.OnboardingCanvas,
  })),
);

const CREATION_PHASE_INDEX = SPLIT_STEP_ORDER.indexOf("creation");

export const FullShell = () => {
  const { state, updateState } = useUiState();
  const activeConversationId = state.conversationId;
  const { gradientMode, gradientColor } = useTheme();
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const [onboardingDemoMorphing, setOnboardingDemoMorphing] = useState(false);
  const [stellaHiddenByPhase, setStellaHiddenByPhase] = useState(false);
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeDemoRef = useRef<OnboardingDemo>(null);
  const fogDefsRef = useRef<SVGSVGElement | null>(null);
  const onboarding = useOnboardingOverlay();
  const { runtimeStatus, runtimeError, retryRuntimeBootstrap } =
    useBootstrapState();
  const { handleDiscoveryConfirm } = useDiscoveryFlow({
    conversationId: activeConversationId,
  });

  const handleDemoChange = useCallback((demo: OnboardingDemo) => {
    if (demo) {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
        demoCloseTimerRef.current = null;
      }

      setDemoClosing(false);
      setActiveDemo(demo);
      activeDemoRef.current = demo;
      return;
    }

    if (activeDemoRef.current === null) {
      return;
    }

    activeDemoRef.current = null;
    setDemoClosing(true);
    demoCloseTimerRef.current = setTimeout(() => {
      setActiveDemo(null);
      setDemoClosing(false);
      demoCloseTimerRef.current = null;
    }, 400);
  }, []);

  // Once onboarding is complete, do not reuse the onboarding creature as a
  // runtime startup screen. The app shell can mount while bootstrap prepares
  // the active conversation; chat controls already handle a missing
  // conversation id by staying disabled until bootstrap provides one.
  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone);
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    updateState({
      suppressNativeRadialDuringOnboarding: !onboarding.onboardingDone,
    });
  }, [onboarding.onboardingDone, updateState]);

  // Kick off the onboarding chunk as soon as we know we'll need it. This
  // runs in parallel with auth bootstrap, so by the time the user clicks
  // "Start Stella" the entire flow is already resident — no mid-flow
  // chunk fetches, no Suspense fallbacks visible to the user. Once
  // `onboardingDone` flips true the import promise simply persists in
  // memory until the FullShell tree unmounts; React never re-fetches.
  useEffect(() => {
    if (onboarding.onboardingDone) return;
    void loadOnboardingChunk();
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
      }
    };
  }, []);

  const handleOnboardingPhaseChange = useCallback((phase: OnboardingPhase) => {
    const splitIndex = SPLIT_STEP_ORDER.indexOf(phase);
    setStellaHiddenByPhase(
      CREATION_PHASE_INDEX >= 0 && splitIndex >= CREATION_PHASE_INDEX,
    );
  }, []);

  useEffect(() => {
    const fogDefs = fogDefsRef.current;
    if (!fogDefs) return;

    // Pause the fog drift during creation-phase morphs and during the
    // onboarding exit transition (so the fade-out reads as a calm dissolve
    // rather than a moving texture being clipped to nothing).
    if (onboardingDemoMorphing || onboarding.onboardingExiting) {
      fogDefs.pauseAnimations();
    } else {
      fogDefs.unpauseAnimations();
    }
  }, [onboardingDemoMorphing, onboarding.onboardingExiting]);

  const appReady = onboarding.onboardingDone;
  const showOnboardingDemos = activeDemo || demoClosing;
  const pauseOnboardingMotion =
    onboardingDemoMorphing || onboarding.onboardingExiting;
  const pauseStellaAnimation =
    pauseOnboardingMotion ||
    Boolean(activeDemo) ||
    (!appReady && stellaHiddenByPhase);

  useEffect(() => {
    if (!appReady) return;
    if (activeConversationId) return;
    if (runtimeStatus !== "ready") return;

    // Bootstrap can finish while RouterProvider is still unmounted during
    // onboarding. If the handoff ever loses the conversation id, kick the
    // light bootstrap loop once more after the real app tree mounts instead
    // of leaving the chat runtime stuck in its initial loading state until a
    // process relaunch.
    retryRuntimeBootstrap();
  }, [activeConversationId, appReady, retryRuntimeBootstrap, runtimeStatus]);

  return (
    <div
      className="window-shell full"
      data-window-mode={appReady ? "app" : "onboarding"}
      data-onboarding-exiting={
        !appReady && onboarding.onboardingExiting ? "true" : undefined
      }
    >
      {!appReady ? (
        <svg
          ref={fogDefsRef}
          className="onboarding-fog-defs"
          width="0"
          height="0"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <filter
              id="stella-fog-distort"
              x="-15%"
              y="-15%"
              width="130%"
              height="130%"
              colorInterpolationFilters="sRGB"
            >
              {/* Filter values are tuned for a 600x400 source element
               * (see .window-shell.full[data-window-mode="onboarding"]::after).
               * The CSS-scale multiplier on that element is roughly 3x on a
               * typical window, so baseFrequency is 3x the original "screen
               * pixel" tuning and displacement scale is 1/3 — giving the
               * same on-screen noise wavelength and warp distance as before
               * while filtering ~9x fewer pixels. */}
              {/* Linear interpolation + closed-loop values keep motion
               * continuous: spline ease-in-out caused zero-velocity
               * "dwell" frames at every keyframe, which read as the fog
               * going briefly static. Each leg below covers a similar
               * 2D distance in (freqX, freqY) / displacement space so
               * apparent speed stays roughly constant throughout the
               * loop, with no near-stationary segment. */}
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.018 0.027"
                numOctaves="2"
                seed="7"
                result="fogNoise"
              >
                <animate
                  attributeName="baseFrequency"
                  dur="29s"
                  values="0.018 0.027;0.026 0.022;0.022 0.034;0.014 0.030;0.018 0.027"
                  keyTimes="0;0.25;0.5;0.75;1"
                  calcMode="linear"
                  repeatCount="indefinite"
                />
              </feTurbulence>
              <feDisplacementMap
                in="SourceGraphic"
                in2="fogNoise"
                scale="18.33"
                xChannelSelector="R"
                yChannelSelector="G"
              >
                <animate
                  attributeName="scale"
                  dur="19s"
                  values="17;23;14;20;17"
                  keyTimes="0;0.25;0.5;0.75;1"
                  calcMode="linear"
                  repeatCount="indefinite"
                />
              </feDisplacementMap>
            </filter>
          </defs>
        </svg>
      ) : null}
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        lightweight={false}
      />
      <MorphInputAbsorber />

      <div className="full-body">
        {appReady ? (
          <PageSidebarProvider>
            <RouterProvider router={router} />
            <AskStellaSelectionChip />
          </PageSidebarProvider>
        ) : (
          <div
            className="onboarding-layout"
            data-split={onboarding.splitMode || undefined}
            data-demo={showOnboardingDemos || undefined}
          >
            <Suspense fallback={null}>
              <OnboardingView
                hasExpanded={onboarding.hasExpanded}
                onboardingDone={onboarding.onboardingDone}
                onboardingExiting={onboarding.onboardingExiting}
                isAuthenticated={onboarding.isAuthenticated}
                isAuthLoading={onboarding.isAuthLoading}
                isPreparingRuntime={runtimeStatus === "preparing"}
                runtimeError={runtimeStatus === "failed" ? runtimeError : null}
                splitMode={onboarding.splitMode}
                hasDiscoverySelections={onboarding.hasDiscoverySelections}
                hasStarted={onboarding.hasStarted}
                stellaAnimationRef={onboarding.stellaAnimationRef}
                stellaAnimationPaused={pauseStellaAnimation}
                stellaAnimationHidden={stellaHiddenByPhase}
                onboardingKey={onboarding.onboardingKey}
                triggerFlash={onboarding.triggerFlash}
                startOnboarding={onboarding.startOnboarding}
                completeOnboarding={onboarding.completeOnboarding}
                handleEnterSplit={onboarding.handleEnterSplit}
                onRetryRuntime={retryRuntimeBootstrap}
                onDiscoveryConfirm={handleDiscoveryConfirm}
                onSelectionChange={onboarding.setHasDiscoverySelections}
                onDemoChange={handleDemoChange}
                onPhaseChange={handleOnboardingPhaseChange}
                activeDemo={activeDemo}
              />
              <div
                className="onboarding-demo-area"
                data-visible={showOnboardingDemos ? true : undefined}
                data-closing={demoClosing || undefined}
                aria-hidden={!showOnboardingDemos}
              >
                <OnboardingCanvas
                  activeDemo={activeDemo}
                  onMorphingChange={setOnboardingDemoMorphing}
                />
              </div>
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
};
