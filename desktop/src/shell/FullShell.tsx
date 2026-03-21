import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTheme } from "@/context/theme-context";
import { useUiState } from "@/context/ui-state";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import {
  OnboardingView,
  useOnboardingOverlay,
} from "@/global/onboarding/OnboardingOverlay";
import { ShiftingGradient } from "./background/ShiftingGradient";
import "./full-shell.layout.css";
import { TitleBar } from "./TitleBar";

const OnboardingCanvas = lazy(() =>
  import("@/global/onboarding/OnboardingCanvas").then((module) => ({
    default: module.OnboardingCanvas,
  })),
);
const FullShellReadySurface = lazy(() =>
  import("./FullShellReadySurface").then((module) => ({
    default: module.FullShellReadySurface,
  })),
);

export const FullShell = () => {
  const { state } = useUiState();
  const activeConversationId = state.conversationId;
  const { gradientMode, gradientColor } = useTheme();
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const [demoMorphing, setDemoMorphing] = useState(false);
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeDemoRef = useRef<OnboardingDemo>(null);
  const onboarding = useOnboardingOverlay();
  const { handleDiscoveryConfirm, dashboardState } = useDiscoveryFlow({
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
    setActiveDemo(null);
    setDemoClosing(true);
    demoCloseTimerRef.current = setTimeout(() => {
      setDemoClosing(false);
      demoCloseTimerRef.current = null;
    }, 400);
  }, []);

  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone);
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
      }
    };
  }, []);

  const appReady = onboarding.onboardingDone;
  const showOnboardingDemos = activeDemo || demoClosing;

  return (
    <div className="window-shell full">
      <TitleBar />
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        lightweight={!appReady}
      />

      <div className="full-body">
        {appReady ? (
          <Suspense fallback={null}>
            <FullShellReadySurface
              dashboardState={dashboardState}
              onboardingExiting={onboarding.onboardingExiting}
            />
          </Suspense>
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
              splitMode={onboarding.splitMode}
              hasDiscoverySelections={onboarding.hasDiscoverySelections}
              hasStarted={onboarding.hasStarted}
              stellaAnimationRef={onboarding.stellaAnimationRef}
              onboardingKey={onboarding.onboardingKey}
              triggerFlash={onboarding.triggerFlash}
              startOnboarding={onboarding.startOnboarding}
              completeOnboarding={onboarding.completeOnboarding}
              handleEnterSplit={onboarding.handleEnterSplit}
              onDiscoveryConfirm={handleDiscoveryConfirm}
              onSelectionChange={onboarding.setHasDiscoverySelections}
              onDemoChange={handleDemoChange}
              activeDemo={activeDemo}
              demoMorphing={demoMorphing}
            />
            <div
              className="onboarding-demo-area"
              data-visible={showOnboardingDemos ? true : undefined}
              data-closing={demoClosing || undefined}
              aria-hidden={!showOnboardingDemos}
            >
              <Suspense fallback={null}>
                <OnboardingCanvas
                  activeDemo={activeDemo}
                  onMorphStateChange={setDemoMorphing}
                />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
