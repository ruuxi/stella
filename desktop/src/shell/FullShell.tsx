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
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import {
  OnboardingView,
  useOnboardingOverlay,
} from "@/global/onboarding/OnboardingOverlay";
import { useBootstrapState } from "@/systems/boot/bootstrap-state";
import { router } from "@/router";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { MorphInputAbsorber } from "./MorphInputAbsorber";
import { AskStellaSelectionChip } from "./selection/AskStellaSelectionChip";
import "./full-shell.layout.css";
import "./mobile.css";

const OnboardingCanvas = lazy(() =>
  import("@/global/onboarding/OnboardingCanvas").then((module) => ({
    default: module.OnboardingCanvas,
  })),
);

export const FullShell = () => {
  const { state, updateState } = useUiState();
  const activeConversationId = state.conversationId;
  const { gradientMode, gradientColor } = useTheme();
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeDemoRef = useRef<OnboardingDemo>(null);
  const onboarding = useOnboardingOverlay();
  const {
    runtimeStatus,
    runtimeError,
    retryRuntimeBootstrap,
  } = useBootstrapState();
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

  // The IPC `app:setReady` signal and the local `appReady` (router-mount)
  // gate are intentionally asymmetric:
  //   * Main-process `setAppReady(onboardingDone)` fires as soon as the user
  //     finishes onboarding, even if the kernel worker is still preparing or
  //     failed. This unblocks system integrations (window controls, voice,
  //     hotkeys) that don't depend on the runtime.
  //   * `appReady` below additionally requires `runtimeStatus === "ready"`
  //     before mounting `<RouterProvider>`, because routes like `/chat` and
  //     `/social` invoke runtime hooks that would crash on a "preparing"
  //     runtime. The onboarding view shows runtime preparing/error state in
  //     the meantime.
  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone);
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    updateState({
      suppressNativeContextMenuDuringOnboarding: !onboarding.onboardingDone,
    });
  }, [onboarding.onboardingDone, updateState]);

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
      }
    };
  }, []);

  const appReady = onboarding.onboardingDone && runtimeStatus === "ready";
  const showOnboardingDemos = activeDemo || demoClosing;

  return (
    <div className="window-shell full">
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
              onboardingKey={onboarding.onboardingKey}
              triggerFlash={onboarding.triggerFlash}
              startBirthAnimation={onboarding.startBirthAnimation}
              startOnboarding={onboarding.startOnboarding}
              completeOnboarding={onboarding.completeOnboarding}
              handleEnterSplit={onboarding.handleEnterSplit}
              onRetryRuntime={retryRuntimeBootstrap}
              onDiscoveryConfirm={handleDiscoveryConfirm}
              onSelectionChange={onboarding.setHasDiscoverySelections}
              onDemoChange={handleDemoChange}
              activeDemo={activeDemo}
            />
            <div
              className="onboarding-demo-area"
              data-visible={showOnboardingDemos ? true : undefined}
              data-closing={demoClosing || undefined}
              aria-hidden={!showOnboardingDemos}
            >
              <Suspense fallback={null}>
                <OnboardingCanvas activeDemo={activeDemo} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
