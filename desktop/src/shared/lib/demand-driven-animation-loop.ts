export type DemandDrivenAnimationLoop = {
  isRunning: () => boolean;
  start: () => void;
  stop: () => void;
};

type DemandDrivenAnimationLoopOptions = {
  cancelFrame?: (id: number) => void;
  clearTimer?: (id: number) => void;
  maxFramesPerSecond: number;
  now?: () => number;
  onFrame: (time: number) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
};

/** A restart-safe rAF loop whose callbacks are requested only at its FPS cap. */
export const createDemandDrivenAnimationLoop = ({
  cancelFrame = cancelAnimationFrame,
  clearTimer = window.clearTimeout,
  maxFramesPerSecond,
  now = performance.now.bind(performance),
  onFrame,
  requestFrame = requestAnimationFrame,
  setTimer = window.setTimeout,
}: DemandDrivenAnimationLoopOptions): DemandDrivenAnimationLoop => {
  const frameIntervalMs = 1000 / Math.max(1, maxFramesPerSecond);
  let frameId: number | undefined;
  let timerId: number | undefined;
  let lastFrameAt: number | undefined;
  let running = false;

  const requestNextFrame = () => {
    timerId = undefined;
    if (!running || frameId !== undefined) return;
    frameId = requestFrame(runFrame);
  };

  const scheduleNextFrame = () => {
    if (!running) return;
    const elapsed =
      lastFrameAt === undefined ? frameIntervalMs : now() - lastFrameAt;
    const delayMs = Math.max(0, frameIntervalMs - elapsed);
    if (delayMs <= 1) {
      requestNextFrame();
      return;
    }
    timerId = setTimer(requestNextFrame, delayMs);
  };

  function runFrame(time: number) {
    frameId = undefined;
    if (!running) return;
    lastFrameAt = time;
    onFrame(time);
    scheduleNextFrame();
  }

  return {
    isRunning: () => running,
    start: () => {
      if (running) return;
      running = true;
      lastFrameAt = undefined;
      requestNextFrame();
    },
    stop: () => {
      running = false;
      if (frameId !== undefined) cancelFrame(frameId);
      if (timerId !== undefined) clearTimer(timerId);
      frameId = undefined;
      timerId = undefined;
      lastFrameAt = undefined;
    },
  };
};
