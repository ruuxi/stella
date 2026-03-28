import type { ProcessRuntime } from "./process-runtime.js";

export type ManagedResource<TPublic extends Record<string, unknown> = Record<string, never>> = {
  start: () => void;
  stop: () => Promise<void>;
} & TPublic;

export type ManagedResourceConfig<TService> = {
  processRuntime: ProcessRuntime;
  canStart?: () => boolean;
  create: (hooks: { onUnexpectedExit: (error: string) => void }) => TService;
  setup?: (service: TService) => void;
  start: (service: TService) => Promise<void>;
  stop: (service: TService) => Promise<void>;
  onAttempt?: (info: { attempt: number }) => void;
  onStarted?: () => void;
  onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void;
  onError?: (error: string) => void;
  retry?: { baseDelayMs?: number; maxDelayMs?: number; fixedDelayMs?: number };
  oneShot?: boolean;
};

export const createManagedResource = <
  TService,
  TPublic extends Record<string, unknown> = Record<string, never>,
>(
  config: ManagedResourceConfig<TService>,
  extraApi?: (controls: { getService: () => TService | null }) => TPublic,
): ManagedResource<TPublic> => {
  let service: TService | null = null;
  let launchPromise: Promise<void> | null = null;
  let retryTimerCancel: (() => void) | null = null;
  let stopped = true;
  let retryAttempt = 0;
  let completed = false;
  let generation = 0;

  const clearRetryTimer = () => {
    retryTimerCancel?.();
    retryTimerCancel = null;
  };

  const stopService = async () => {
    const active = service;
    service = null;
    if (active) await config.stop(active).catch(() => undefined);
  };

  const computeDelay = () => {
    if (config.retry?.fixedDelayMs != null) return config.retry.fixedDelayMs;
    const base = config.retry?.baseDelayMs ?? 1_000;
    const max = config.retry?.maxDelayMs ?? 30_000;
    return Math.min(base * 2 ** Math.max(0, retryAttempt - 1), max);
  };

  const scheduleRetry = (error: string) => {
    if (stopped || config.processRuntime.isShuttingDown()) return;
    retryAttempt += 1;
    const delayMs = computeDelay();
    config.onRetry?.({ attempt: retryAttempt, delayMs, error });
    clearRetryTimer();
    retryTimerCancel = config.processRuntime.setManagedTimeout(() => {
      retryTimerCancel = null;
      void ensureStarted();
    }, delayMs);
  };

  const ensureStarted = () => {
    if (launchPromise || stopped || completed || config.processRuntime.isShuttingDown()) {
      return launchPromise ?? Promise.resolve();
    }
    if (config.canStart && !config.canStart()) {
      return Promise.resolve();
    }

    generation += 1;
    const startGeneration = generation;
    config.onAttempt?.({ attempt: retryAttempt });

    const current = config.create({
      onUnexpectedExit: (error) => {
        if (service !== current) return;
        service = null;
        scheduleRetry(error);
      },
    });
    config.setup?.(current);
    service = current;

    launchPromise = config
      .start(current)
      .then(() => {
        if (generation !== startGeneration) return;
        retryAttempt = 0;
        config.onStarted?.();
        if (config.oneShot) completed = true;
      })
      .catch(async (err) => {
        if (service === current) service = null;
        await config.stop(current).catch(() => undefined);
        if (generation !== startGeneration) return;
        const msg = err instanceof Error ? err.message : String(err);
        config.onError?.(msg);
        scheduleRetry(msg);
      })
      .finally(() => {
        launchPromise = null;
      });

    return launchPromise;
  };

  const publicExtra = extraApi?.({ getService: () => service }) ?? ({} as TPublic);

  return {
    start: () => {
      stopped = false;
      if (service || launchPromise || completed || config.processRuntime.isShuttingDown()) return;
      void ensureStarted();
    },
    stop: async () => {
      stopped = true;
      generation += 1;
      clearRetryTimer();
      await stopService();
    },
    ...publicExtra,
  };
};
