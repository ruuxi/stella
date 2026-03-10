import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredVoiceRuntime } from "../../../../src/app/voice-runtime/DeferredVoiceRuntime";

vi.mock("@/app/voice-runtime/VoiceRuntimeRoot", () => ({
  VoiceRuntimeRoot: () => <div data-testid="voice-runtime-root" />,
}));

describe("DeferredVoiceRuntime", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("waits until after the first animation frame to load the voice runtime", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    render(<DeferredVoiceRuntime />);

    expect(screen.queryByTestId("voice-runtime-root")).not.toBeInTheDocument();
    expect(scheduledFrame).not.toBeNull();

    await act(async () => {
      scheduledFrame?.(16);
    });

    expect(await screen.findByTestId("voice-runtime-root")).toBeInTheDocument();
  });
});
