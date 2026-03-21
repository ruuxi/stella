import { ipcMain } from "electron";
import type { IpcMainEvent } from "electron";
import { emitStartupMetric, isStartupProfilingEnabled } from "../startup/profiler.js";

type StartupMetricReportPayload = {
  atMs?: number;
  detail?: Record<string, unknown>;
  metric:
    | "renderer-first-contentful-paint"
    | "renderer-first-paint"
    | "renderer-full-shell-mounted"
    | "renderer-ui-interactive";
};

type StartupMetricHandlersOptions = {
  assertPrivilegedSender: (event: IpcMainEvent, channel: string) => void;
};

export const registerStartupMetricHandlers = ({
  assertPrivilegedSender,
}: StartupMetricHandlersOptions) => {
  if (!isStartupProfilingEnabled()) {
    return;
  }

  ipcMain.on(
    "startupMetrics:report",
    (event, payload: StartupMetricReportPayload) => {
      assertPrivilegedSender(event, "startupMetrics:report");
      emitStartupMetric({
        atMs: payload.atMs,
        detail: payload.detail,
        metric: payload.metric,
        source: "electron-renderer",
      });
    },
  );
};
