import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { FullShell } from "@/shell/FullShell";

vi.mock("@/context/ui-state", () => ({
  useUiState: () => ({
    state: {
      mode: "chat",
      window: "full",
      view: "home",
      conversationId: "conv-123",
    },
    setMode: vi.fn(),
    setView: vi.fn(),
    setConversationId: vi.fn(),
    setWindow: vi.fn(),
    updateState: vi.fn(),
  }),
}));

vi.mock("@/context/theme-context", () => ({
  useTheme: () => ({
    gradientMode: "soft",
    gradientColor: "relative",
  }),
}));

const mockUseBootstrapState = vi.fn();

vi.mock("@/systems/boot/bootstrap-state", () => ({
  useBootstrapState: () => mockUseBootstrapState(),
}));

vi.mock("@/global/onboarding/OnboardingOverlay", () => ({
  useOnboardingOverlay: () => ({
    onboardingDone: true,
    onboardingExiting: false,
    completeOnboarding: vi.fn(),
    isAuthenticated: true,
    isAuthLoading: false,
    hasExpanded: false,
    hasStarted: false,
    splitMode: false,
    hasDiscoverySelections: false,
    setHasDiscoverySelections: vi.fn(),
    onboardingKey: "test",
    stellaAnimationRef: createRef(),
    triggerFlash: vi.fn(),
    startBirthAnimation: vi.fn(),
    startOnboarding: vi.fn(),
    handleEnterSplit: vi.fn(),
  }),
  OnboardingView: () => <div data-testid="onboarding-view" />,
}));

vi.mock("@/global/onboarding/DiscoveryFlow", () => ({
  useDiscoveryFlow: () => ({
    handleDiscoveryConfirm: vi.fn(),
    dashboardState: null,
  }),
}));

vi.mock("@/shell/background/ShiftingGradient", () => ({
  ShiftingGradient: () => <div data-testid="shifting-gradient" />,
}));

vi.mock("@/shell/TitleBar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}));

vi.mock("@/global/onboarding/OnboardingCanvas", () => ({
  OnboardingCanvas: () => <div data-testid="onboarding-canvas" />,
}));

describe("FullShell bootstrap readiness", () => {
  beforeEach(() => {
    mockUseBootstrapState.mockReturnValue({
      runtimeStatus: "preparing",
      runtimeError: null,
      bootstrapAttempt: 0,
      markPreparing: vi.fn(),
      markReady: vi.fn(),
      markFailed: vi.fn(),
      retryRuntimeBootstrap: vi.fn(),
    });
  });

  it("keeps the onboarding surface visible while Stella is still preparing", () => {
    render(<FullShell />);

    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-view")).toBeInTheDocument();
  });
});
