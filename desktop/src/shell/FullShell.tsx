import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { RouterProvider } from "@tanstack/react-router";
import { useTheme } from "@/context/theme-context";
import { useUiState } from "@/context/ui-state";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import {
  SPLIT_STEP_ORDER,
  type Phase as OnboardingPhase,
} from "@/global/onboarding/onboarding-flow";
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import { useOnboardingOverlay } from "@/global/onboarding/use-onboarding-overlay";
import {
  readLocalOnboardingCompleted,
  useOnboardingState,
} from "@/global/onboarding/use-onboarding-state";
import { useBootstrapState } from "@/bootstrap/bootstrap-state";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { preloadAllNavSurfaces } from "@/shell/topbar/nav-surface-preloads";
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { MorphInputAbsorber } from "./MorphInputAbsorber";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import "./full-shell.layout.css";
import "./mobile.css";

/* Onboarding is loaded as a dynamic chunk that contains the flow:
 * every phase component, the StellaAnimation creature, the legal dialog,
 * and all onboarding CSS. The demo canvas (`OnboardingCanvas` + the
 * StellaAppMock subtree) is a separate sibling chunk preloaded in
 * parallel so it's ready by the time the user reaches the creation phase;
 * it also lives under its own Suspense boundary so a cold-load race can't
 * hide the active phase's Continue button.
 *
 * Returning users (`appReady === true` at first paint) never fetch these
 * chunks. After completion the React subtree unmounts and the lazy
 * imports are never re-evaluated, so onboarding code is genuinely gone
 * for the remainder of the session and absent from the next cold start. */
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

const preloadOnboardingCanvas = () => {
  void import("@/global/onboarding/OnboardingCanvas");
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

const dismissLaunchSplash = () => {
  const launch = document.getElementById("stella-launch");
  if (!launch) return;

  launch.dataset.exiting = "true";
  window.setTimeout(() => {
    launch.remove();
  }, 260);
};

type OnboardingExperienceProps = {
  activeConversationId: string | null;
  onEnteredApp: () => void;
};

function OnboardingExperience({
  activeConversationId,
  onEnteredApp,
}: OnboardingExperienceProps) {
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const onboardingDemoMorphing = false;
  const [stellaHiddenByPhase, setStellaHiddenByPhase] = useState(false);
  const [onboardingPhase, setOnboardingPhase] =
    useState<OnboardingPhase>("intro");
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeDemoRef = useRef<OnboardingDemo>(null);
  const onboarding = useOnboardingOverlay();
  const {
    handleDiscoveryConfirm,
    discoveryWelcomeExpected,
    discoveryWelcomeReady,
  } = useDiscoveryFlow({
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

  useEffect(() => {
    let cancelled = false;
    void loadOnboardingChunk().finally(() => {
      if (!cancelled) dismissLaunchSplash();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const splitIndex = SPLIT_STEP_ORDER.indexOf(onboardingPhase);
    if (
      splitIndex >= 0 &&
      CREATION_PHASE_INDEX >= 0 &&
      splitIndex >= CREATION_PHASE_INDEX - 1
    ) {
      preloadOnboardingCanvas();
    }
  }, [onboardingPhase]);

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
      }
    };
  }, []);

  const handleOnboardingPhaseChange = useCallback(
    (phase: OnboardingPhase) => {
      setOnboardingPhase(phase);
      onboarding.persistPhase(phase);
      const splitIndex = SPLIT_STEP_ORDER.indexOf(phase);
      setStellaHiddenByPhase(
        CREATION_PHASE_INDEX >= 0 && splitIndex >= CREATION_PHASE_INDEX,
      );
    },
    [onboarding],
  );

  // Phases whose own animations dominate the frame budget; we keep the
  // creature visible but pause its rAF canvas loop so the heavy phase
  // gets the full frame budget. (`creation` and later are already covered
  // by `stellaHiddenByPhase` above, which both hides AND pauses.)
  const stellaPausedByHeavyPhase = onboardingPhase === "capabilities";

  const showOnboardingDemos = activeDemo || demoClosing;
  const pauseOnboardingMotion =
    onboardingDemoMorphing || onboarding.onboardingExiting;
  const pauseStellaAnimation =
    pauseOnboardingMotion ||
    Boolean(activeDemo) ||
    stellaHiddenByPhase ||
    stellaPausedByHeavyPhase;

  useEffect(() => {
    if (!onboarding.onboardingDone) return;
    onEnteredApp();
  }, [onEnteredApp, onboarding.onboardingDone]);

  return (
    <>
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
            splitMode={onboarding.splitMode}
            splitEntering={onboarding.splitEntering}
            hasDiscoverySelections={onboarding.hasDiscoverySelections}
            hasStarted={onboarding.hasStarted}
            stellaAnimationRef={onboarding.stellaAnimationRef}
            stellaAnimationPaused={pauseStellaAnimation}
            stellaAnimationHidden={stellaHiddenByPhase}
            onboardingKey={onboarding.onboardingKey}
            initialPhase={onboarding.initialPhase}
            creatureInitialBirth={onboarding.creatureInitialBirth}
            triggerFlash={onboarding.triggerFlash}
            startOnboarding={onboarding.startOnboarding}
            completeOnboarding={onboarding.completeOnboarding}
            handleEnterSplit={onboarding.handleEnterSplit}
            onDiscoveryConfirm={handleDiscoveryConfirm}
            onSelectionChange={onboarding.setHasDiscoverySelections}
            onDemoChange={handleDemoChange}
            onPhaseChange={handleOnboardingPhaseChange}
            activeDemo={activeDemo}
            discoveryWelcomeExpected={discoveryWelcomeExpected}
            discoveryWelcomeReady={discoveryWelcomeReady}
          />
        </Suspense>
        {/* Canvas is its own Suspense boundary so a cold lazy-chunk load
         * on entering the `creation` phase can't suspend the overlay above
         * and momentarily hide the Continue button. */}
        <Suspense fallback={null}>
          <div
            className="onboarding-demo-area"
            data-visible={showOnboardingDemos ? true : undefined}
            data-closing={demoClosing || undefined}
            aria-hidden={!showOnboardingDemos}
          >
            {showOnboardingDemos ? (
              <OnboardingCanvas activeDemo={activeDemo} />
            ) : null}
          </div>
        </Suspense>
      </div>
    </>
  );
}

export const FullShell = () => {
  const windowType = useWindowType();
  const isMiniWindow = windowType === "mini";
  const { state, updateState } = useUiState();
  const activeConversationId = state.conversationId;
  const { gradientMode, gradientColor } = useTheme();
  const { completed: onboardingDone, hydrated: onboardingHydrated } =
    useOnboardingState();
  // Returning users resolve `onboardingDone` synchronously from localStorage,
  // so seed `hasEnteredApp` synchronously too — otherwise the chat-surface /
  // RouterProvider mount is deferred to a separate macrotask by the
  // setTimeout(0) effect below. The splash stays up until `appReady`, so there
  // is no flash. The onboarding -> app transition still defers via the
  // `onEnteredApp` path. (Mini windows are excluded; they gate on
  // `isMiniWindow` in `appReady` directly.)
  const [hasEnteredApp, setHasEnteredApp] = useState(
    () => !isMiniWindow && readLocalOnboardingCompleted(),
  );
  const { runtimeStatus, retryRuntimeBootstrap } = useBootstrapState();

  const onboardingResolved = onboardingHydrated || onboardingDone;
  const appReady =
    onboardingResolved && onboardingDone && (isMiniWindow || hasEnteredApp);
  const needsOnboarding = onboardingHydrated && !onboardingDone;

  useEffect(() => {
    if (!onboardingResolved || !onboardingDone) return;
    const timer = window.setTimeout(() => {
      setHasEnteredApp(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onboardingDone, onboardingResolved]);

  // The renderer shell does not depend on auth or the local runtime. Those
  // background bootstraps only unlock cloud state, chat history, sends, and
  // local tools once their own state arrives.
  useEffect(() => {
    if (isMiniWindow) return;
    window.electronAPI?.ui.setAppReady?.(appReady);
  }, [appReady, isMiniWindow]);

  useEffect(() => {
    updateState({
      suppressNativeRadialDuringOnboarding: !appReady,
    });
  }, [appReady, updateState]);

  // Keep the static launch splash up for returning users until React has
  // mounted the real shell. First-run onboarding dismisses it after its chunk
  // is loaded from OnboardingExperience.
  useEffect(() => {
    if (appReady) {
      dismissLaunchSplash();
    }
  }, [appReady]);

  useEffect(() => {
    if (!appReady) return;
    const scheduleIdle =
      window.requestIdleCallback ??
      ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 0,
            } as IdleDeadline),
          1,
        ));
    const cancelIdle =
      window.cancelIdleCallback ??
      ((handle: number) => window.clearTimeout(handle));
    const idleHandle = scheduleIdle(() => {
      preloadAllNavSurfaces();
    });
    return () => cancelIdle(idleHandle);
  }, [appReady]);

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
      data-window-mode={needsOnboarding ? "onboarding" : "app"}
    >
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        lightweight={false}
      />
      <MorphInputAbsorber />

      <div className="full-body">
        {appReady ? (
          <>
            <RouterProvider router={router} />
            <AskStellaSelectionChip />
          </>
        ) : needsOnboarding ? (
          <OnboardingExperience
            activeConversationId={activeConversationId}
            onEnteredApp={() => setHasEnteredApp(true)}
          />
        ) : null}
      </div>
    </div>
  );
};
