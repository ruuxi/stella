import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, act, renderHook } from "@testing-library/react";
import React from "react";
import { OnboardingView, useOnboardingOverlay } from "./OnboardingOverlay";

// ---------- Mocks ----------

vi.mock("../../components/StellaAnimation", () => ({
  StellaAnimation: React.forwardRef((_props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      triggerFlash: vi.fn(),
      startBirth: vi.fn(),
      reset: vi.fn(),
    }));
    return <div data-testid="stella-animation" />;
  }),
}));

vi.mock("../../components/Onboarding", () => ({
  OnboardingStep1: (props: any) => (
    <div data-testid="onboarding-step1">
      <button data-testid="complete-btn" onClick={props.onComplete}>
        Complete
      </button>
      <button data-testid="accept-btn" onClick={props.onAccept}>
        Accept
      </button>
      <button data-testid="interact-btn" onClick={props.onInteract}>
        Interact
      </button>
      <button
        data-testid="enter-split-btn"
        onClick={props.onEnterSplit}
      >
        Enter Split
      </button>
    </div>
  ),
  useOnboardingState: vi.fn(),
}));

vi.mock("../../components/InlineAuth", () => ({
  InlineAuth: (props: any) => (
    <div data-testid="inline-auth" className={props.className} />
  ),
}));

const mockResetUserData = vi.fn().mockResolvedValue(undefined);

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(),
  useAction: () => mockResetUserData,
}));

vi.mock("@/convex/api", () => ({
  api: { reset: { resetAllUserData: "resetAllUserData" } },
}));

const mockUseIsLocalMode = vi.fn(() => false);
vi.mock("@/providers/DataProvider", () => ({
  useIsLocalMode: () => mockUseIsLocalMode(),
}));

// Re-import mock references for per-test overrides
import { useConvexAuth } from "convex/react";
import { useOnboardingState } from "../../components/Onboarding";

const mockedUseConvexAuth = vi.mocked(useConvexAuth);
const mockedUseOnboardingState = vi.mocked(useOnboardingState) as any;

// ---------- Helpers ----------

function makeProps(
  overrides: Partial<Parameters<typeof OnboardingView>[0]> = {},
) {
  return {
    hasExpanded: false,
    onboardingDone: false,
    onboardingExiting: false,
    isAuthenticated: false,
    splitMode: false,
    hasDiscoverySelections: false,
    stellaAnimationRef: React.createRef<any>(),
    onboardingKey: 0,
    triggerFlash: vi.fn(),
    startBirthAnimation: vi.fn(),
    completeOnboarding: vi.fn(),
    handleEnterSplit: vi.fn(),
    onDiscoveryConfirm: vi.fn(),
    ...overrides,
  };
}

// ---------- OnboardingView Component Tests ----------

describe("OnboardingView", () => {
  it('renders "Stella" title text', () => {
    render(<OnboardingView {...makeProps()} />);
    expect(screen.getByText("Stella")).toBeTruthy();
  });

  it("shows OnboardingStep1 when onboardingDone=false", () => {
    render(<OnboardingView {...makeProps({ onboardingDone: false })} />);
    expect(screen.getByTestId("onboarding-step1")).toBeTruthy();
  });

  it("hides OnboardingStep1 when onboardingDone=true", () => {
    render(<OnboardingView {...makeProps({ onboardingDone: true })} />);
    expect(screen.queryByTestId("onboarding-step1")).toBeNull();
  });

  it("shows InlineAuth when !isAuthenticated && onboardingDone", () => {
    render(
      <OnboardingView
        {...makeProps({ isAuthenticated: false, onboardingDone: true })}
      />,
    );
    expect(screen.getByTestId("inline-auth")).toBeTruthy();
  });

  it("hides InlineAuth when authenticated", () => {
    render(
      <OnboardingView
        {...makeProps({ isAuthenticated: true, onboardingDone: true })}
      />,
    );
    expect(screen.queryByTestId("inline-auth")).toBeNull();
  });

  it("hides InlineAuth when onboarding not done (even if not authenticated)", () => {
    render(
      <OnboardingView
        {...makeProps({ isAuthenticated: false, onboardingDone: false })}
      />,
    );
    expect(screen.queryByTestId("inline-auth")).toBeNull();
  });

  it("sets data-expanded attribute on title based on hasExpanded", () => {
    const { rerender } = render(
      <OnboardingView {...makeProps({ hasExpanded: false })} />,
    );
    const title = screen.getByText("Stella");
    expect(title.getAttribute("data-expanded")).toBe("false");

    rerender(<OnboardingView {...makeProps({ hasExpanded: true })} />);
    expect(title.getAttribute("data-expanded")).toBe("true");
  });

  it("sets data-split on container based on splitMode", () => {
    const { container, rerender } = render(
      <OnboardingView {...makeProps({ splitMode: false })} />,
    );
    const view = container.querySelector(".new-session-view")!;
    expect(view.getAttribute("data-split")).toBe("false");

    rerender(<OnboardingView {...makeProps({ splitMode: true })} />);
    expect(view.getAttribute("data-split")).toBe("true");
  });

  it("sets data-exiting on container when onboardingExiting is true", () => {
    const { container } = render(
      <OnboardingView {...makeProps({ onboardingExiting: true })} />,
    );
    const view = container.querySelector(".new-session-view")!;
    expect(view.getAttribute("data-exiting")).toBe("true");
  });

  it("does not set data-exiting when onboardingExiting is false/undefined", () => {
    const { container } = render(
      <OnboardingView {...makeProps({ onboardingExiting: false })} />,
    );
    const view = container.querySelector(".new-session-view")!;
    expect(view.getAttribute("data-exiting")).toBeNull();
  });

  it("calls triggerFlash and startBirthAnimation on creature click when not expanded", () => {
    const triggerFlash = vi.fn();
    const startBirthAnimation = vi.fn();
    const { container } = render(
      <OnboardingView
        {...makeProps({
          hasExpanded: false,
          triggerFlash,
          startBirthAnimation,
        })}
      />,
    );
    const creatureArea = container.querySelector(
      ".onboarding-stella-animation",
    )!;
    fireEvent.click(creatureArea);
    expect(triggerFlash).toHaveBeenCalledOnce();
    expect(startBirthAnimation).toHaveBeenCalledOnce();
  });

  it("calls triggerFlash but not startBirthAnimation on creature click when already expanded", () => {
    const triggerFlash = vi.fn();
    const startBirthAnimation = vi.fn();
    const { container } = render(
      <OnboardingView
        {...makeProps({
          hasExpanded: true,
          triggerFlash,
          startBirthAnimation,
        })}
      />,
    );
    const creatureArea = container.querySelector(
      ".onboarding-stella-animation",
    )!;
    fireEvent.click(creatureArea);
    expect(triggerFlash).toHaveBeenCalledOnce();
    expect(startBirthAnimation).not.toHaveBeenCalled();
  });

  it("sets data-expanded and data-split on the stella animation wrapper", () => {
    const { container } = render(
      <OnboardingView
        {...makeProps({ hasExpanded: true, splitMode: true })}
      />,
    );
    const wrapper = container.querySelector(".onboarding-stella-animation")!;
    expect(wrapper.getAttribute("data-expanded")).toBe("true");
    expect(wrapper.getAttribute("data-split")).toBe("true");
  });

  it("sets data-has-selections on stella animation wrapper when hasDiscoverySelections is true", () => {
    const { container } = render(
      <OnboardingView {...makeProps({ hasDiscoverySelections: true })} />,
    );
    const wrapper = container.querySelector(".onboarding-stella-animation")!;
    expect(wrapper.getAttribute("data-has-selections")).toBe("true");
  });

  it('shows title="Click to awaken" when not expanded', () => {
    const { container } = render(
      <OnboardingView {...makeProps({ hasExpanded: false })} />,
    );
    const wrapper = container.querySelector(".onboarding-stella-animation")!;
    expect(wrapper.getAttribute("title")).toBe("Click to awaken");
  });

  it("does not show awaken title when expanded", () => {
    const { container } = render(
      <OnboardingView {...makeProps({ hasExpanded: true })} />,
    );
    const wrapper = container.querySelector(".onboarding-stella-animation")!;
    expect(wrapper.getAttribute("title")).toBeNull();
  });

  it("renders StellaAnimation with initialBirthProgress=1 when onboardingDone", () => {
    render(<OnboardingView {...makeProps({ onboardingDone: true })} />);
    expect(screen.getByTestId("stella-animation")).toBeInTheDocument();
  });

  it("renders StellaAnimation with initialBirthProgress=CREATURE_INITIAL_SIZE when not done", () => {
    render(<OnboardingView {...makeProps({ onboardingDone: false })} />);
    expect(screen.getByTestId("stella-animation")).toBeInTheDocument();
  });

  it("applies onboarding-inline-auth--static class to InlineAuth", () => {
    render(
      <OnboardingView
        {...makeProps({ isAuthenticated: false, onboardingDone: true })}
      />,
    );
    const authEl = screen.getByTestId("inline-auth");
    expect(authEl.className).toBe("onboarding-inline-auth--static");
  });
});

// ---------- useOnboardingOverlay Hook Tests ----------

describe("useOnboardingOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockUseIsLocalMode.mockReturnValue(false);
    mockedUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockedUseOnboardingState.mockReturnValue({
      completed: false,
      complete: vi.fn(),
      reset: vi.fn(),
    });
    mockResetUserData.mockResolvedValue(undefined);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns initial state correctly when onboarding is not done", () => {
    mockedUseOnboardingState.mockReturnValue({
      completed: false,
      complete: vi.fn(),
      reset: vi.fn(),
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    expect(result.current.onboardingDone).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasExpanded).toBe(false);
    expect(result.current.splitMode).toBe(false);
    expect(result.current.hasDiscoverySelections).toBe(false);
    expect(result.current.onboardingExiting).toBe(false);
    expect(result.current.onboardingKey).toBe(0);
  });

  it("returns initial state correctly when onboarding is completed", () => {
    mockedUseOnboardingState.mockReturnValue({
      completed: true,
      complete: vi.fn(),
      reset: vi.fn(),
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    expect(result.current.onboardingDone).toBe(true);
    // hasExpanded is initialized from onboardingDone
    expect(result.current.hasExpanded).toBe(true);
  });

  it("reflects isAuthLoading from useConvexAuth", () => {
    mockedUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    expect(result.current.isAuthLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("treats local mode as authenticated even when cloud auth is false", () => {
    mockUseIsLocalMode.mockReturnValue(true);
    mockedUseConvexAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isAuthLoading).toBe(false);
  });

  it("startBirthAnimation sets hasExpanded to true", () => {
    const { result } = renderHook(() => useOnboardingOverlay());
    expect(result.current.hasExpanded).toBe(false);

    act(() => {
      result.current.startBirthAnimation();
    });

    expect(result.current.hasExpanded).toBe(true);
  });

  it("startBirthAnimation does nothing when already expanded", () => {
    mockedUseOnboardingState.mockReturnValue({
      completed: true,
      complete: vi.fn(),
      reset: vi.fn(),
    });

    const { result } = renderHook(() => useOnboardingOverlay());
    expect(result.current.hasExpanded).toBe(true);

    // Calling again should not error
    act(() => {
      result.current.startBirthAnimation();
    });

    expect(result.current.hasExpanded).toBe(true);
  });

  it("handleEnterSplit sets splitMode to true", () => {
    const { result } = renderHook(() => useOnboardingOverlay());
    expect(result.current.splitMode).toBe(false);

    act(() => {
      result.current.handleEnterSplit();
    });

    expect(result.current.splitMode).toBe(true);
  });

  it("completeOnboarding sets exiting then completes after timeout", () => {
    const mockComplete = vi.fn();
    mockedUseOnboardingState.mockReturnValue({
      completed: false,
      complete: mockComplete,
      reset: vi.fn(),
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    // Enter split first, then complete
    act(() => {
      result.current.handleEnterSplit();
    });
    expect(result.current.splitMode).toBe(true);

    act(() => {
      result.current.completeOnboarding();
    });

    // splitMode should be set to false immediately
    expect(result.current.splitMode).toBe(false);
    // exiting should be true
    expect(result.current.onboardingExiting).toBe(true);
    // complete not called yet
    expect(mockComplete).not.toHaveBeenCalled();

    // Advance past 800ms timer
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(mockComplete).toHaveBeenCalledOnce();

    // Advance past the inner 400ms timer
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current.onboardingExiting).toBe(false);
  });

  it("handleResetOnboarding resets all state and calls resetUserData", async () => {
    const mockReset = vi.fn();
    mockedUseOnboardingState.mockReturnValue({
      completed: false,
      complete: vi.fn(),
      reset: mockReset,
    });

    // Mock location.reload
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    // First expand and enter split mode
    act(() => {
      result.current.startBirthAnimation();
      result.current.handleEnterSplit();
    });

    expect(result.current.hasExpanded).toBe(true);
    expect(result.current.splitMode).toBe(true);

    await act(async () => {
      result.current.handleResetOnboarding();
      // Let the promise resolve
      await Promise.resolve();
    });

    expect(result.current.hasExpanded).toBe(false);
    expect(result.current.splitMode).toBe(false);
    expect(result.current.onboardingExiting).toBe(false);
    expect(result.current.onboardingKey).toBe(1);
    expect(mockReset).toHaveBeenCalledOnce();
    expect(mockResetUserData).toHaveBeenCalledOnce();
  });

  it("handleResetOnboarding clears exit timer if one is pending", () => {
    const mockComplete = vi.fn();
    const mockReset = vi.fn();
    mockedUseOnboardingState.mockReturnValue({
      completed: false,
      complete: mockComplete,
      reset: mockReset,
    });

    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    const { result } = renderHook(() => useOnboardingOverlay());

    // Start completing (which sets a timeout)
    act(() => {
      result.current.completeOnboarding();
    });
    expect(result.current.onboardingExiting).toBe(true);

    // Reset before the exit timer fires
    act(() => {
      result.current.handleResetOnboarding();
    });

    // Advance timers — the old exit timeout should have been cleared
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // complete should NOT have been called because we cleared the timer
    expect(mockComplete).not.toHaveBeenCalled();
    expect(result.current.onboardingExiting).toBe(false);
  });

  it("setHasDiscoverySelections updates state", () => {
    const { result } = renderHook(() => useOnboardingOverlay());
    expect(result.current.hasDiscoverySelections).toBe(false);

    act(() => {
      result.current.setHasDiscoverySelections(true);
    });

    expect(result.current.hasDiscoverySelections).toBe(true);
  });
});
