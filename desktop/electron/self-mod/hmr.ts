import { setTimeout as delay } from "timers/promises";

const HMR_ENDPOINT_BASE = "/__stella/self-mod/hmr";
const REQUEST_TIMEOUT_MS = 4_000;
const PAUSE_MAX_WAIT_MS = 8_000;
const RESUME_MAX_WAIT_MS = 90_000;

type HmrControllerOptions = {
  getDevServerUrl: () => string;
  enabled: boolean;
};

const withTimeoutSignal = (timeoutMs: number): AbortSignal => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener(
    "abort",
    () => clearTimeout(timer),
    { once: true },
  );
  return controller.signal;
};

const postWithRetry = async (args: {
  getDevServerUrl: () => string;
  path: string;
  maxWaitMs: number;
}): Promise<boolean> => {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < args.maxWaitMs) {
    attempt += 1;
    const baseUrl = args.getDevServerUrl().replace(/\/+$/, "");
    const target = `${baseUrl}${args.path}`;

    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: withTimeoutSignal(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        return true;
      }

      // If the endpoint does not exist, there is nothing to control.
      if (response.status === 404) {
        return false;
      }
    } catch {
      // Vite may be restarting (dependency install / optimize); retry until maxWait.
    }

    const backoffMs = Math.min(1_500, 250 * attempt);
    await delay(backoffMs);
  }

  return false;
};

export const createSelfModHmrController = (options: HmrControllerOptions) => {
  const activeRuns = new Set<string>();

  const pause = async (runId: string): Promise<boolean> => {
    if (!options.enabled) {
      activeRuns.add(runId);
      return true;
    }

    activeRuns.add(runId);
    if (activeRuns.size > 1) {
      return true;
    }

    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/pause`,
      maxWaitMs: PAUSE_MAX_WAIT_MS,
    });
  };

  const resume = async (runId: string): Promise<boolean> => {
    activeRuns.delete(runId);
    if (activeRuns.size > 0) {
      return true;
    }
    if (!options.enabled) {
      return true;
    }

    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/resume`,
      maxWaitMs: RESUME_MAX_WAIT_MS,
    });
  };

  const forceResumeAll = async (): Promise<boolean> => {
    activeRuns.clear();
    if (!options.enabled) {
      return true;
    }
    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/resume`,
      maxWaitMs: RESUME_MAX_WAIT_MS,
    });
  };

  return {
    pause,
    resume,
    forceResumeAll,
    isPaused: () => activeRuns.size > 0,
  };
};

