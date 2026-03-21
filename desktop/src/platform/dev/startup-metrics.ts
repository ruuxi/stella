let firstPaintObservedAtMs: number | null = null;
let pendingInteractiveReport = false;

type RendererStartupMetric =
  | "renderer-first-contentful-paint"
  | "renderer-first-paint"
  | "renderer-full-shell-mounted"
  | "renderer-ui-interactive";

const reportRendererStartupMetric = (
  metric: RendererStartupMetric,
  atMs: number,
  detail?: Record<string, unknown>,
) => {
  window.electronAPI?.startupMetrics?.report({
    atMs,
    detail,
    metric,
  });
};

const flushPendingInteractiveReport = () => {
  if (!pendingInteractiveReport || firstPaintObservedAtMs === null) {
    return;
  }

  pendingInteractiveReport = false;
  reportRendererStartupMetric("renderer-ui-interactive", Date.now(), {
    window: "full",
  });
};

const observePaintMetrics = () => {
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  const seenPaintNames = new Set<string>();

  const forwardPaintEntry = (entry: PerformanceEntry) => {
    if (seenPaintNames.has(entry.name)) {
      return;
    }

    seenPaintNames.add(entry.name);
    const atMs = Math.round(performance.timeOrigin + entry.startTime);

    if (entry.name === "first-paint") {
      firstPaintObservedAtMs = atMs;
      reportRendererStartupMetric("renderer-first-paint", atMs, {
        paintName: entry.name,
        window: "full",
      });
      flushPendingInteractiveReport();
      return;
    }

    if (entry.name === "first-contentful-paint") {
      reportRendererStartupMetric("renderer-first-contentful-paint", atMs, {
        paintName: entry.name,
        window: "full",
      });
    }
  };

  for (const entry of performance.getEntriesByType("paint")) {
    forwardPaintEntry(entry);
  }

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      forwardPaintEntry(entry);
    }
  });

  observer.observe({ entryTypes: ["paint"] });
};

export const initializeStartupPaintMetrics = () => {
  if (!window.electronAPI?.startupMetrics) {
    return;
  }

  observePaintMetrics();
};

export const reportRendererStartupMetricNow = (
  metric: RendererStartupMetric,
  detail?: Record<string, unknown>,
) => {
  if (!window.electronAPI?.startupMetrics) {
    return;
  }

  reportRendererStartupMetric(metric, Date.now(), detail);
};

export const reportInteractiveAfterNextPaint = () => {
  if (!window.electronAPI?.startupMetrics) {
    return;
  }

  let reported = false;
  const finalize = () => {
    if (reported) {
      return;
    }

    reported = true;

    if (firstPaintObservedAtMs === null) {
      pendingInteractiveReport = true;
      globalThis.setTimeout(() => {
        if (pendingInteractiveReport) {
          pendingInteractiveReport = false;
          reportRendererStartupMetric("renderer-ui-interactive", Date.now(), {
            window: "full",
          });
        }
      }, 1000);
      return;
    }

    reportRendererStartupMetric("renderer-ui-interactive", Date.now(), {
      window: "full",
    });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => {
          finalize();
        }, { timeout: 250 });
        return;
      }

      globalThis.setTimeout(finalize, 0);
    });
  });
};
