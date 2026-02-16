import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

// Mock the lazy-loaded demo components. React.lazy needs the import to return
// a module with a default export. The vi.mock factory replaces the entire
// import() result, so the lazy() wrapper will resolve with these components.
vi.mock("./panels/DJStudioDemo", () => ({
  default: () => <div data-testid="dj-studio-demo">DJ Studio Demo</div>,
}));

vi.mock("./panels/WeatherStationDemo", () => ({
  default: () => (
    <div data-testid="weather-station-demo">Weather Station Demo</div>
  ),
}));

// Mock the Spinner component
vi.mock("../spinner", () => ({
  Spinner: () => <div data-testid="spinner">Loading...</div>,
}));

import { OnboardingCanvas } from "./OnboardingCanvas";
import type { OnboardingDemo } from "./OnboardingCanvas";

describe("OnboardingCanvas", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    // Install fake timers first, then override rAF so our spy is not
    // clobbered by the fake timer installation.
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const flushRaf = () => {
    const callbacks = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of callbacks) cb(performance.now());
  };

  // ----------------------------------------------------------------
  // Null demo
  // ----------------------------------------------------------------
  it("renders nothing when activeDemo is null", () => {
    const { container } = render(<OnboardingCanvas activeDemo={null} />);
    expect(container.querySelector(".onboarding-canvas")).toBeNull();
  });

  // ----------------------------------------------------------------
  // Shows Suspense fallback (spinner) while lazy components load
  // ----------------------------------------------------------------
  it("shows spinner as suspense fallback initially", () => {
    const { container } = render(<OnboardingCanvas activeDemo="dj-studio" />);

    // Suspense should show the spinner fallback
    expect(container.querySelector(".onboarding-canvas")).not.toBeNull();
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // DJ Studio demo loads after suspension resolves
  // ----------------------------------------------------------------
  it("renders DJ Studio demo after lazy component resolves", async () => {
    vi.useRealTimers(); // Need real timers for async lazy resolution

    render(<OnboardingCanvas activeDemo="dj-studio" />);

    const demo = await waitFor(() => screen.getByTestId("dj-studio-demo"));
    expect(demo).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // Weather Station demo loads after suspension resolves
  // ----------------------------------------------------------------
  it("renders Weather Station demo after lazy component resolves", async () => {
    vi.useRealTimers();

    render(<OnboardingCanvas activeDemo="weather-station" />);

    const demo = await waitFor(() =>
      screen.getByTestId("weather-station-demo"),
    );
    expect(demo).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // CSS classes: initial state before rAF
  // ----------------------------------------------------------------
  it("does not have open class before rAF fires", () => {
    const { container } = render(<OnboardingCanvas activeDemo="dj-studio" />);

    const canvas = container.querySelector(".onboarding-canvas");
    expect(canvas).not.toBeNull();
    // Before rAF fires, visible is false so no open class
    expect(canvas!.classList.contains("onboarding-canvas-open")).toBe(false);
  });

  // ----------------------------------------------------------------
  // CSS classes: after rAF
  // ----------------------------------------------------------------
  it("adds open class after rAF when demo is active", () => {
    const { container } = render(<OnboardingCanvas activeDemo="dj-studio" />);

    const canvas = container.querySelector(".onboarding-canvas");
    expect(canvas).not.toBeNull();

    // Flush the rAF to trigger setVisible(true)
    act(() => {
      flushRaf();
    });

    expect(canvas!.classList.contains("onboarding-canvas-open")).toBe(true);
  });

  // ----------------------------------------------------------------
  // Closing animation
  // ----------------------------------------------------------------
  it("applies closing class when demo transitions from active to null", () => {
    const { container, rerender } = render(
      <OnboardingCanvas activeDemo="dj-studio" />,
    );

    // Flush rAF so visible=true
    act(() => {
      flushRaf();
    });

    // Now remove the demo
    rerender(<OnboardingCanvas activeDemo={null} />);

    const canvas = container.querySelector(".onboarding-canvas");
    // During close animation, element should still be present with closing class
    expect(canvas).not.toBeNull();
    expect(canvas!.classList.contains("onboarding-canvas-closing")).toBe(true);
    expect(canvas!.classList.contains("onboarding-canvas-open")).toBe(false);
  });

  // ----------------------------------------------------------------
  // After closing animation finishes
  // ----------------------------------------------------------------
  it("removes element after closing animation duration", () => {
    const { container, rerender } = render(
      <OnboardingCanvas activeDemo="dj-studio" />,
    );

    // Make visible=true
    act(() => {
      flushRaf();
    });

    // Close
    rerender(<OnboardingCanvas activeDemo={null} />);

    // Advance past ANIM_DURATION (350ms)
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const canvas = container.querySelector(".onboarding-canvas");
    expect(canvas).toBeNull();
  });

  // ----------------------------------------------------------------
  // Switching demos
  // ----------------------------------------------------------------
  it("switches between demos on rerender", async () => {
    vi.useRealTimers();

    const { rerender } = render(<OnboardingCanvas activeDemo="dj-studio" />);

    await waitFor(() => {
      expect(screen.getByTestId("dj-studio-demo")).toBeInTheDocument();
    });

    rerender(<OnboardingCanvas activeDemo="weather-station" />);

    await waitFor(() => {
      expect(
        screen.getByTestId("weather-station-demo"),
      ).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Type export
  // ----------------------------------------------------------------
  it("OnboardingDemo type includes expected values", () => {
    const demo1: OnboardingDemo = "dj-studio";
    const demo2: OnboardingDemo = "weather-station";
    const demo3: OnboardingDemo = null;
    expect(demo1).toBe("dj-studio");
    expect(demo2).toBe("weather-station");
    expect(demo3).toBeNull();
  });

  // ----------------------------------------------------------------
  // Canvas container has correct base class
  // ----------------------------------------------------------------
  it("wraps content in onboarding-canvas container", () => {
    const { container } = render(<OnboardingCanvas activeDemo="dj-studio" />);

    const canvas = container.querySelector(".onboarding-canvas");
    expect(canvas).not.toBeNull();
  });
});
