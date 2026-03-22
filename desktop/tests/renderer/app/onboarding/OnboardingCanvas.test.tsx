import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingCanvas } from "../../../../src/global/onboarding/OnboardingCanvas";

vi.mock("../../../../src/global/onboarding/panels/DJStudioDemo", () => ({
  DJStudio: () => <div data-testid="dj-studio-demo">DJ Studio Demo</div>,
}));

vi.mock("../../../../src/global/onboarding/panels/WeatherStationDemo", () => ({
  WeatherStation: () => (
    <div data-testid="weather-station-demo">Weather Station Demo</div>
  ),
}));

vi.mock("../../../../src/global/onboarding/panels/CozyCatDemo", () => ({
  CozyCatDemo: () => <div data-testid="cozy-cat-demo">Cozy Cat Demo</div>,
}));

vi.mock("../../../../src/global/onboarding/panels/StellaAppMock", () => ({
  StellaAppMock: ({ variant }: { variant: string }) => (
    <div data-testid={`stella-app-${variant}`}>Stella {variant}</div>
  ),
}));

vi.mock("../../../../src/global/onboarding/panels/PomodoroDemo", () => ({
  PomodoroDemo: () => <div data-testid="pomodoro-demo">Pomodoro Demo</div>,
}));

describe("OnboardingCanvas", () => {
  afterEach(() => {
    delete (window as typeof window & { electronAPI?: unknown }).electronAPI;
  });

  it("renders nothing when activeDemo is null", () => {
    const { container } = render(<OnboardingCanvas activeDemo={null} />);
    expect(container.querySelector(".onboarding-canvas")).toBeNull();
  });

  it("renders the selected demo", () => {
    render(<OnboardingCanvas activeDemo="dj-studio" />);
    expect(screen.getByTestId("dj-studio-demo")).toBeInTheDocument();
  });

  it("switches between demos on rerender", async () => {
    const { rerender } = render(<OnboardingCanvas activeDemo="dj-studio" />);

    expect(screen.getByTestId("dj-studio-demo")).toBeInTheDocument();

    rerender(<OnboardingCanvas activeDemo="weather-station" />);

    await waitFor(() => {
      expect(screen.getByTestId("weather-station-demo")).toBeInTheDocument();
    });
  });

  it("retries native morph startup before falling back", async () => {
    const morphStart = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const morphComplete = vi.fn().mockResolvedValue({ ok: true });

    (
      window as typeof window & {
        electronAPI?: {
          ui: {
            morphStart: typeof morphStart;
            morphComplete: typeof morphComplete;
          };
        };
      }
    ).electronAPI = {
      ui: {
        morphStart,
        morphComplete,
      },
    };

    const { rerender } = render(<OnboardingCanvas activeDemo="default" />);
    expect(screen.getByTestId("stella-app-default")).toBeInTheDocument();

    rerender(<OnboardingCanvas activeDemo="dj-studio" />);

    await waitFor(() => {
      expect(morphStart).toHaveBeenCalledTimes(3);
      expect(morphComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    expect(screen.getByTestId("dj-studio-demo")).toBeInTheDocument();
  });
});
