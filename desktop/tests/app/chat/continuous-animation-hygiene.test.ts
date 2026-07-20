import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { shouldRunContinuousAnimation } from "@/shared/hooks/use-continuous-animation-gate";
import { createDemandDrivenAnimationLoop } from "@/shared/lib/demand-driven-animation-loop";

describe("continuous animation hygiene", () => {
  it("requires live state, visible pixels, a visible app, and allowed motion", () => {
    const base = {
      documentVisible: true,
      elementVisible: true,
      logicalActive: true,
      reducedMotion: false,
      windowFocused: true,
    };
    expect(shouldRunContinuousAnimation(base)).toBe(true);
    expect(
      shouldRunContinuousAnimation({ ...base, logicalActive: false }),
    ).toBe(false);
    expect(
      shouldRunContinuousAnimation({ ...base, elementVisible: false }),
    ).toBe(false);
    expect(
      shouldRunContinuousAnimation({ ...base, documentVisible: false }),
    ).toBe(false);
    expect(shouldRunContinuousAnimation({ ...base, reducedMotion: true })).toBe(
      false,
    );
    expect(
      shouldRunContinuousAnimation({
        ...base,
        requireWindowFocus: true,
        windowFocused: false,
      }),
    ).toBe(false);
  });

  it("caps callbacks and cancels every pending handle across restarts", () => {
    let now = 0;
    let nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    const onFrame = vi.fn();
    const loop = createDemandDrivenAnimationLoop({
      maxFramesPerSecond: 30,
      now: () => now,
      onFrame,
      requestFrame: (callback) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (id) => frames.delete(id),
      setTimer: (callback) => {
        const id = nextId++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });

    loop.start();
    loop.start();
    expect(frames.size).toBe(1);
    const firstFrame = [...frames.entries()][0]!;
    frames.delete(firstFrame[0]);
    firstFrame[1](0);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(1);

    now = 34;
    const timer = [...timers.entries()][0]!;
    timers.delete(timer[0]);
    timer[1]();
    expect(frames.size).toBe(1);

    loop.stop();
    expect(loop.isRunning()).toBe(false);
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);

    loop.start();
    expect(frames.size).toBe(1);
    loop.stop();
    expect(frames.size).toBe(0);
  });

  it("keeps persistent chat motion compositor-only and explicitly gated", () => {
    const shimmerCss = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/chat/text-shimmer.css"),
      "utf8",
    );
    const activityCss = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/chat/chat-workspace-strip.css"),
      "utf8",
    );
    const stella = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/shell/ascii-creature/StellaAnimation.tsx",
      ),
      "utf8",
    );

    expect(shimmerCss).not.toContain("background-position");
    for (const name of ["text-shimmer-window", "text-shimmer-content"]) {
      const keyframes = shimmerCss.match(
        new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
      )?.[1];
      expect(keyframes).toContain("transform:");
      expect(keyframes).not.toMatch(/background|filter|width|left:/);
    }
    expect(activityCss).toContain('data-continuous-animation="true"');
    expect(activityCss).toContain(
      ':nth-child(\n    1 of .chat-workspace-strip__task-row[data-status="running"]',
    );
    expect(stella).toContain("createDemandDrivenAnimationLoop");
    expect(stella).toContain("renderStatic();");
    expect(stella).not.toContain("requestAnimationFrame(animate)");
  });
});
