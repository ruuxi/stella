type StartupMetricName =
  | "bootstrap-context-created"
  | "bootstrap-application-initialize-started"
  | "bootstrap-local-state-ready"
  | "dev-electron-launcher-ready"
  | "electron-main-entry"
  | "electron-spawn-requested"
  | "full-window-created"
  | "full-window-shown"
  | "host-runtime-ready"
  | "renderer-first-contentful-paint"
  | "renderer-first-paint"
  | "renderer-full-shell-mounted"
  | "renderer-ui-interactive"
  | "vite-dev-server-listening";

type StartupMetricPayload = {
  atMs?: number;
  detail?: Record<string, unknown>;
  metric: StartupMetricName;
  source: "electron-main" | "electron-renderer" | "vite" | "dev-launcher";
};

const STARTUP_LOG_PREFIX = "[stella-startup]";
const startupProfilingEnabled = process.env.STELLA_STARTUP_PROFILING === "1";
const traceId = process.env.STELLA_STARTUP_TRACE_ID ?? null;
const emittedMetricKeys = new Set<string>();

const getMetricKey = (
  metric: StartupMetricName,
  detail?: Record<string, unknown>,
) => {
  const windowTarget =
    typeof detail?.window === "string" ? detail.window : "default";
  return `${metric}:${windowTarget}`;
};

export const isStartupProfilingEnabled = () => startupProfilingEnabled;

export const emitStartupMetric = ({
  atMs,
  detail,
  metric,
  source,
}: StartupMetricPayload) => {
  if (!startupProfilingEnabled) {
    return;
  }

  const metricKey = getMetricKey(metric, detail);
  if (emittedMetricKeys.has(metricKey)) {
    return;
  }

  emittedMetricKeys.add(metricKey);

  console.log(
    `${STARTUP_LOG_PREFIX} ${JSON.stringify({
      atMs: atMs ?? Date.now(),
      detail: detail ?? {},
      metric,
      pid: process.pid,
      source,
      traceId,
    })}`,
  );
};
