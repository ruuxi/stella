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
import {
  useAuthBootstrapState,
  type AuthBootstrapStatus,
} from "@/global/auth/DesktopConvexAuthProvider";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import {
  SPLIT_STEP_ORDER,
  type Phase as OnboardingPhase,
} from "@/global/onboarding/onboarding-flow";
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import { useOnboardingOverlay } from "@/global/onboarding/use-onboarding-overlay";
import { useOnboardingState } from "@/global/onboarding/use-onboarding-state";
import { useBootstrapState } from "@/systems/boot/bootstrap-state";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { preloadAllSidebarSurfaces } from "@/shared/lib/sidebar-preloads";
import { storeSidePanelStore } from "@/global/store/store-side-panel-store";
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { MorphInputAbsorber } from "./MorphInputAbsorber";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import { openStoreDisplayTab } from "./display/default-tabs";
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
  runtimeAuthReady: boolean;
  authBootstrapStatus: AuthBootstrapStatus;
  isPreparingStartup: boolean;
  startupError: string | null;
  onRetryStartup: () => void;
  onEnteredApp: () => void;
};

function OnboardingExperience({
  activeConversationId,
  runtimeAuthReady,
  authBootstrapStatus,
  isPreparingStartup,
  startupError,
  onRetryStartup,
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
            isAuthLoading={
              onboarding.isAuthLoading ||
              (!runtimeAuthReady && authBootstrapStatus !== "failed")
            }
            isPreparingRuntime={isPreparingStartup}
            runtimeError={startupError}
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
            onRetryRuntime={onRetryStartup}
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

function PostOnboardingStartupGate({
  startupError,
  onRetryStartup,
}: {
  startupError: string | null;
  onRetryStartup: () => void;
}) {
  if (!startupError) return null;

  return (
    <div className="post-onboarding-startup-gate">
      <button className="pill-btn pill-btn-primary" onClick={onRetryStartup}>
        Retry Stella Startup
      </button>
    </div>
  );
}

export const FullShell = () => {
  const windowType = useWindowType();
  const isMiniWindow = windowType === "mini";
  const { state, updateState } = useUiState();
  const activeConversationId = state.conversationId;
  const { gradientMode, gradientColor } = useTheme();
  const { completed: onboardingDone } = useOnboardingState();
  const [hasEnteredApp, setHasEnteredApp] = useState(false);
  const {
    runtimeAuthReady,
    status: authBootstrapStatus,
    error: authBootstrapError,
  } = useAuthBootstrapState();
  const { runtimeStatus, runtimeError, retryRuntimeBootstrap } =
    useBootstrapState();

  const startupReady = runtimeAuthReady && runtimeStatus === "ready";
  const appReady =
    onboardingDone && (isMiniWindow || hasEnteredApp || startupReady);
  const needsOnboarding = !onboardingDone;
  const isPreparingStartup =
    runtimeStatus === "preparing" ||
    (!runtimeAuthReady && authBootstrapStatus !== "failed");
  const startupError =
    authBootstrapStatus === "failed"
      ? authBootstrapError
      : runtimeStatus === "failed"
        ? runtimeError
        : null;

  const handleRetryStartup = useCallback(() => {
    if (authBootstrapStatus === "failed") {
      window.location.reload();
      return;
    }
    retryRuntimeBootstrap();
  }, [authBootstrapStatus, retryRuntimeBootstrap]);

  useEffect(() => {
    if (!onboardingDone || !startupReady) return;
    const timer = window.setTimeout(() => {
      setHasEnteredApp(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onboardingDone, startupReady]);

  // The desktop app should not mount before auth has reached the runtime on
  // startup. Once mounted, later sign-out/sign-in transitions keep the app
  // visible while auth falls back to an anonymous local session.
  useEffect(() => {
    if (isMiniWindow) return;
    window.electronAPI?.ui.setAppReady?.(appReady);
  }, [appReady, isMiniWindow]);

  useEffect(() => {
    updateState({
      suppressNativeRadialDuringOnboarding: !appReady,
    });
  }, [appReady, updateState]);

  // Keep the static launch splash up for returning users until the real app is
  // ready. First-run onboarding preloads its chunk from OnboardingExperience.
  useEffect(() => {
    if (appReady || startupError) {
      dismissLaunchSplash();
    }
  }, [appReady, startupError]);

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
      preloadAllSidebarSurfaces();
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

  useEffect(() => {
    if (!appReady || isMiniWindow) return;
    return window.electronAPI?.store?.onBlueprintNotificationActivated?.(
      ({ messageId }) => {
        storeSidePanelStore.requestBlueprintActivation(messageId);
        openStoreDisplayTab();
      },
    );
  }, [appReady, isMiniWindow]);

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
          <PageSidebarProvider>
            <RouterProvider router={router} />
            <AskStellaSelectionChip />
          </PageSidebarProvider>
        ) : needsOnboarding ? (
          <OnboardingExperience
            activeConversationId={activeConversationId}
            runtimeAuthReady={runtimeAuthReady}
            authBootstrapStatus={authBootstrapStatus}
            isPreparingStartup={isPreparingStartup}
            startupError={startupError}
            onRetryStartup={handleRetryStartup}
            onEnteredApp={() => setHasEnteredApp(true)}
          />
        ) : (
          <PostOnboardingStartupGate
            startupError={startupError}
            onRetryStartup={handleRetryStartup}
          />
        )}
      </div>
    </div>
  );
};
