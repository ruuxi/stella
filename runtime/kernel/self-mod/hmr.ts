import { setTimeout as delay } from "timers/promises";

const HMR_ENDPOINT_BASE = "/__stella/self-mod/hmr";
// Per-attempt timeout — kept tight so we get multiple retries inside the total
// budget when the dev server is slow to accept the connection.
const REQUEST_TIMEOUT_MS = 1_500;
// Total wait budgets — a healthy HMR pause/resume completes in well under a
// second; anything past this points at a wedged dev server and we'd rather
// fail fast than block the agent or hold the morph cover up.
const PAUSE_MAX_WAIT_MS = 5_000;
const RESUME_MAX_WAIT_MS = 5_000;

type HmrControllerOptions = {
  getDevServerUrl: () => string;
  enabled: boolean;
};

export type HmrStatus = {
  paused: boolean;
  queuedFiles: number;
  queuedModules: number;
  requiresFullReload: boolean;
};

type ResumeHmrOptions = {
  suppressClientFullReload?: boolean;
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
  body?: unknown;
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
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
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

  const getStatus = async (): Promise<HmrStatus | null> => {
    if (!options.enabled) {
      return {
        paused: activeRuns.size > 0,
        queuedFiles: 0,
        queuedModules: 0,
        requiresFullReload: false,
      };
    }

    const baseUrl = options.getDevServerUrl().replace(/\/+$/, "");
    const target = `${baseUrl}${HMR_ENDPOINT_BASE}/status`;

    try {
      const response = await fetch(target, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: withTimeoutSignal(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json() as Partial<HmrStatus>;
      return {
        paused: Boolean(payload.paused),
        queuedFiles: Number(payload.queuedFiles ?? 0),
        queuedModules: Number(payload.queuedModules ?? 0),
        requiresFullReload: Boolean(payload.requiresFullReload),
      };
    } catch {
      return null;
    }
  };

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

  const resume = async (
    runId: string,
    resumeOptions?: ResumeHmrOptions,
  ): Promise<boolean> => {
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
      body: resumeOptions,
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
    getStatus,
    isPaused: () => activeRuns.size > 0,
  };
};
