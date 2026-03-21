import {
  lazy,
  Suspense,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { GeneratedPage } from "@/app/registry";
import { WorkspaceArea } from "@/app/workspace/WorkspaceArea";
import { useDevProjects } from "@/context/dev-projects-state";
import { useTheme } from "@/context/theme-context";
import { useUiState } from "@/context/ui-state";
import { useWorkspace } from "@/context/workspace-state";
import { secureSignOut } from "@/global/auth/services/auth";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import { useDiscoveryFlow } from "@/global/onboarding/DiscoveryFlow";
import {
  OnboardingView,
  useOnboardingOverlay,
} from "@/global/onboarding/OnboardingOverlay";
import { Sidebar } from "@/shell/sidebar/Sidebar";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { FullShellDialogs } from "./full-shell-dialogs";
import type { DialogType } from "./full-shell-dialogs";
import {
  reportInteractiveAfterNextPaint,
  reportRendererStartupMetricNow,
} from "@/platform/dev/startup-metrics";
import "./full-shell.layout.css";
import { TitleBar } from "./TitleBar";

const OnboardingCanvas = lazy(() =>
  import("@/global/onboarding/OnboardingCanvas").then((module) => ({
    default: module.OnboardingCanvas,
  })),
);
const fullShellRuntimeImport = import("./FullShellRuntime");
const FullShellRuntime = lazy(() =>
  fullShellRuntimeImport.then((module) => ({
    default: module.FullShellRuntime,
  })),
);

const NEW_APP_ASK_STELLA_PROMPT =
  'The user wants to create a new workspace (app) added to the sidebar with its own content. Be concise and provide 2-4 suggestions and ideas.';

type PendingAskStellaRequest = {
  id: number;
  text: string;
};

export const FullShell = () => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const { state: workspaceState, openPanel, closePanel } = useWorkspace();
  const activePanel = workspaceState.activePanel;
  const { gradientMode, gradientColor } = useTheme();
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const [demoMorphing, setDemoMorphing] = useState(false);
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeDemoRef = useRef<OnboardingDemo>(null);
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const onboarding = useOnboardingOverlay();
  const { projects, pickProjectDirectory } = useDevProjects();
  const { handleDiscoveryConfirm, dashboardState } = useDiscoveryFlow({
    conversationId: activeConversationId,
  });

  const showAuthDialog = useCallback(() => {
    setActiveDialog("auth");
  }, []);

  const showConnectDialog = useCallback(() => {
    setActiveDialog("connect");
  }, []);

  const showSettingsDialog = useCallback(() => {
    setActiveDialog("settings");
  }, []);

  const showStoreView = useCallback(() => {
    closePanel();
    setView("store");
  }, [closePanel, setView]);

  const showHomeView = useCallback(() => {
    closePanel();
    setView("home");
  }, [closePanel, setView]);

  const showChatView = useCallback(() => {
    closePanel();
    setView("chat");
  }, [closePanel, setView]);

  const showSocialView = useCallback(() => {
    closePanel();
    setView("social");
  }, [closePanel, setView]);

  const handlePageSelect = useCallback(
    (page: GeneratedPage) => {
      openPanel({
        kind: "generated-page",
        name: page.id,
        title: page.title,
        pageId: page.id,
      });
      setView("app");
    },
    [openPanel, setView],
  );

  const handlePendingAskStellaHandled = useCallback((requestId: number) => {
    setPendingAskStellaRequest((current) =>
      current?.id === requestId ? null : current,
    );
  }, []);

  const handleNewAppAskStella = useCallback(() => {
    startTransition(() => {
      setRuntimeReady(true);
      setPendingAskStellaRequest({
        id: Date.now(),
        text: NEW_APP_ASK_STELLA_PROMPT,
      });
    });

    if (state.view === "chat") {
      closePanel();
      setView("home");
    }
  }, [closePanel, setView, state.view]);

  const handleProjectSelect = useCallback(
    (project: (typeof projects)[number]) => {
      openPanel({
        name: `dev-project:${project.id}`,
        title: project.name,
        kind: "dev-project",
        projectId: project.id,
      });
      setView("app");
    },
    [openPanel, setView],
  );

  const handleNewAppLocalProject = useCallback(async () => {
    const project = await pickProjectDirectory();
    if (!project) {
      return;
    }

    handleProjectSelect(project);
  }, [handleProjectSelect, pickProjectDirectory]);

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

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setActiveDialog(null);
    }
  }, []);

  const handleSettingsSignOut = useCallback(() => {
    setActiveDialog(null);
    void secureSignOut();
  }, []);

  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone);
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    reportRendererStartupMetricNow("renderer-full-shell-mounted", {
      onboardingDone: onboarding.onboardingDone,
      window: "full",
    });
    reportInteractiveAfterNextPaint();
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    if (!onboarding.onboardingDone || runtimeReady) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      startTransition(() => {
        setRuntimeReady(true);
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [onboarding.onboardingDone, runtimeReady]);

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
      }
    };
  }, []);

  const isOrbVisible =
    state.view !== "chat" &&
    state.view !== "social" &&
    onboarding.onboardingDone;
  const appReady = onboarding.onboardingDone;
  const activeProjectId =
    activePanel?.kind === "dev-project" ? activePanel.projectId : null;
  const activePageId =
    activePanel?.kind === "generated-page" ? activePanel.pageId : null;
  const showOnboardingDemos = activeDemo || demoClosing;
  const showRuntimeShell = runtimeReady && onboarding.onboardingDone;
  const showChatSurface = state.view === "chat" || state.view === "social";

  return (
    <div className="window-shell full">
      <TitleBar />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      <div className="full-body">
        {appReady ? (
          <>
            <Sidebar
              activeView={state.view}
              onSignIn={showAuthDialog}
              onConnect={showConnectDialog}
              onSettings={showSettingsDialog}
              onStore={showStoreView}
              onHome={showHomeView}
              onChat={showChatView}
              onSocial={showSocialView}
              onNewAppAskStella={handleNewAppAskStella}
              onNewAppLocalProject={handleNewAppLocalProject}
              activePageId={activePageId}
              onPageSelect={handlePageSelect}
              dashboardState={dashboardState}
              projects={projects}
              activeProjectId={activeProjectId}
              onProjectSelect={handleProjectSelect}
            />

            <div className="content-area">
              {showChatSurface ? (
                showRuntimeShell ? (
                  <Suspense
                    fallback={
                      <WorkspaceArea
                        view="home"
                        activeDemo={null}
                        demoClosing={false}
                      />
                    }
                  >
                    <FullShellRuntime
                      activeConversationId={activeConversationId}
                      activeView={state.view}
                      composerEntering={onboarding.onboardingExiting}
                      conversationId={activeConversationId}
                      isOrbVisible={false}
                      onSignIn={showAuthDialog}
                      pendingAskStellaRequest={pendingAskStellaRequest}
                      onPendingAskStellaHandled={handlePendingAskStellaHandled}
                    />
                  </Suspense>
                ) : (
                  <WorkspaceArea
                    view="home"
                    activeDemo={null}
                    demoClosing={false}
                  />
                )
              ) : (
                <>
                  <WorkspaceArea
                    view={state.view}
                    activeDemo={activeDemo}
                    demoClosing={demoClosing}
                    conversationId={activeConversationId ?? undefined}
                  />
                  {showRuntimeShell ? (
                    <Suspense fallback={null}>
                      <FullShellRuntime
                        activeConversationId={activeConversationId}
                        activeView={state.view}
                        composerEntering={onboarding.onboardingExiting}
                        conversationId={activeConversationId}
                        isOrbVisible={isOrbVisible}
                        onSignIn={showAuthDialog}
                        pendingAskStellaRequest={pendingAskStellaRequest}
                        onPendingAskStellaHandled={handlePendingAskStellaHandled}
                      />
                    </Suspense>
                  ) : null}
                </>
              )}
            </div>
          </>
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

      <FullShellDialogs
        activeDialog={activeDialog}
        onDialogOpenChange={handleDialogOpenChange}
        onSignOut={handleSettingsSignOut}
      />
    </div>
  );
};
