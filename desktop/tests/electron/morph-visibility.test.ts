import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  screen: {
    getDisplayNearestPoint: vi.fn(() => ({
      scaleFactor: 1,
    })),
  },
}));

const {
  createMorphVisibilitySamplePoints,
  isLikelySameWindowBounds,
  shouldShowMorphForWindow,
} = await import("../../electron/windows/morph-visibility.js");

const targetBounds = { x: 100, y: 80, width: 800, height: 600 };

const createTargetWindow = (
  overrides?: Partial<{
    destroyed: boolean;
    focused: boolean;
    minimized: boolean;
    visible: boolean;
    bounds: typeof targetBounds;
  }>,
) => ({
  getBounds: vi.fn(() => overrides?.bounds ?? targetBounds),
  isDestroyed: vi.fn(() => overrides?.destroyed ?? false),
  isFocused: vi.fn(() => overrides?.focused ?? false),
  isMinimized: vi.fn(() => overrides?.minimized ?? false),
  isVisible: vi.fn(() => overrides?.visible ?? true),
});

const fullWindowInfo = {
  title: "Stella",
  process: "Stella",
  pid: 123,
  bounds: targetBounds,
};

describe("morph visibility gate", () => {
  it("shows the morph immediately for the focused full window", async () => {
    const queryWindowInfo = vi.fn();

    const decision = await shouldShowMorphForWindow(
      createTargetWindow({ focused: true }),
      {
        currentPid: 123,
        platform: "darwin",
        queryWindowInfo,
      },
    );

    expect(decision).toEqual({ showMorph: true, reason: "focused" });
    expect(queryWindowInfo).not.toHaveBeenCalled();
  });

  it("skips the morph for hidden or minimized windows", async () => {
    await expect(
      shouldShowMorphForWindow(createTargetWindow({ visible: false }), {
        platform: "darwin",
        queryWindowInfo: vi.fn(),
      }),
    ).resolves.toMatchObject({ showMorph: false, reason: "hidden" });

    await expect(
      shouldShowMorphForWindow(createTargetWindow({ minimized: true }), {
        platform: "darwin",
        queryWindowInfo: vi.fn(),
      }),
    ).resolves.toMatchObject({ showMorph: false, reason: "minimized" });
  });

  it("shows the morph when enough sampled points still hit the full window", async () => {
    const samples = createMorphVisibilitySamplePoints(targetBounds);
    let calls = 0;
    const queryWindowInfo = vi.fn(async () => {
      calls += 1;
      return calls <= samples.length / 2 ? fullWindowInfo : null;
    });

    const decision = await shouldShowMorphForWindow(createTargetWindow(), {
      currentPid: 123,
      platform: "darwin",
      queryWindowInfo,
    });

    expect(decision).toMatchObject({
      showMorph: true,
      reason: "visible-enough",
      visibleRatio: 0.5,
      visibleSamples: samples.length / 2,
      totalSamples: samples.length,
    });
  });

  it("skips the morph when the full window is mostly covered", async () => {
    let calls = 0;
    const queryWindowInfo = vi.fn(async () => {
      calls += 1;
      return calls <= 5 ? fullWindowInfo : null;
    });

    const decision = await shouldShowMorphForWindow(createTargetWindow(), {
      currentPid: 123,
      platform: "darwin",
      queryWindowInfo,
    });

    expect(decision).toMatchObject({
      showMorph: false,
      reason: "mostly-covered",
      visibleSamples: 5,
    });
    expect(decision.visibleRatio).toBeLessThan(0.5);
  });

  it("does not count another small Stella window as the full window", async () => {
    const queryWindowInfo = vi.fn(async () => ({
      ...fullWindowInfo,
      bounds: { x: 200, y: 160, width: 300, height: 260 },
    }));

    const decision = await shouldShowMorphForWindow(createTargetWindow(), {
      currentPid: 123,
      platform: "darwin",
      queryWindowInfo,
    });

    expect(decision).toMatchObject({
      showMorph: false,
      reason: "mostly-covered",
      visibleSamples: 0,
    });
  });

  it("matches bounds only when the candidate substantially covers the target and itself", () => {
    expect(
      isLikelySameWindowBounds(targetBounds, {
        x: 104,
        y: 84,
        width: 792,
        height: 592,
      }),
    ).toBe(true);
    expect(
      isLikelySameWindowBounds(targetBounds, {
        x: 100,
        y: 80,
        width: 2000,
        height: 1600,
      }),
    ).toBe(false);
  });
});
