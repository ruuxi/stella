import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { useTheme } from "@/context/theme-context";
import { useUiState } from "@/context/ui-state";
import {
  CREATURE_HIDDEN_PHASES,
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
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { MorphInputAbsorber } from "./MorphInputAbsorber";
import { ShellRadialBridge } from "./radial/ShellRadialBridge";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import "./full-shell.layout.css";
import "./mobile.css";

/* Onboarding is loaded as a dynamic chunk that contains the whole flow:
 * every phase component, the StellaAnimation creature, the legal dialog,
 * and all onboarding CSS.
 *
 * Returning users (`appReady === true` at first paint) never fetch this
 * chunk. After completion the React subtree unmounts and the lazy
 * import is never re-evaluated, so onboarding code is genuinely gone
 * for the remainder of the session and absent from the next cold start. */
const onboardingChunkPromise: { current: Promise<unknown> | null } = {
  current: null,
};
const loadOnboardingChunk = () => {
  if (!onboardingChunkPromise.current) {
    onboardingChunkPromise.current = import(
      "@/global/onboarding/OnboardingOverlay"
    );
  }
  return onboardingChunkPromise.current;
};

const OnboardingView = lazy(() =>
  import("@/global/onboarding/OnboardingOverlay").then((module) => ({
    default: module.OnboardingView,
  })),
);

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
  const [stellaHiddenByPhase, setStellaHiddenByPhase] = useState(false);
  const [onboardingPhase, setOnboardingPhase] =
    useState<OnboardingPhase>("intro");
  const onboarding = useOnboardingOverlay();
  const {
    handleDiscoveryConfirm,
    discoveryWelcomeExpected,
    discoveryWelcomeReady,
  } = useDiscoveryFlow({
    conversationId: activeConversationId,
  });

  useEffect(() => {
    let cancelled = false;
    void loadOnboardingChunk().finally(() => {
      if (!cancelled) dismissLaunchSplash();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleOnboardingPhaseChange = useCallback(
    (phase: OnboardingPhase) => {
      setOnboardingPhase(phase);
      onboarding.persistPhase(phase);
      setStellaHiddenByPhase(CREATURE_HIDDEN_PHASES.has(phase));
    },
    [onboarding],
  );

  // Phases whose own animations dominate the frame budget; we keep the
  // creature visible but pause its rAF canvas loop so the heavy phase
  // gets the full frame budget. (CREATURE_HIDDEN_PHASES both hide AND
  // pause via `stellaHiddenByPhase`.)
  const stellaPausedByHeavyPhase = onboardingPhase === "capabilities";

  const pauseStellaAnimation =
    onboarding.onboardingExiting ||
    stellaHiddenByPhase ||
    stellaPausedByHeavyPhase;

  useEffect(() => {
    if (!onboarding.onboardingDone) return;
    onEnteredApp();
  }, [onEnteredApp, onboarding.onboardingDone]);

  return (
    <div
      className="onboarding-layout"
      data-split={onboarding.splitMode || undefined}
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
          onPhaseChange={handleOnboardingPhaseChange}
          discoveryWelcomeExpected={discoveryWelcomeExpected}
          discoveryWelcomeReady={discoveryWelcomeReady}
        />
      </Suspense>
    </div>
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
  // Returning users resolve `onboardingDone` synchronously from shared UI state,
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
            {/* Mounted beside the router rather than inside it: the dial is
                raised from anywhere on the shell surface, including the
                display panel, which portals out of the route tree. */}
            {!isMiniWindow ? <ShellRadialBridge /> : null}
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
