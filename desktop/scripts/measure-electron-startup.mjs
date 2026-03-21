import { spawn } from "node:child_process";
import readline from "node:readline";

const STARTUP_LOG_PREFIX = "[stella-startup]";
const requiredMetrics = [
  "full-window-created",
  "renderer-first-paint",
  "renderer-ui-interactive",
];
const timeoutMs = Number.parseInt(
  process.env.STELLA_STARTUP_TIMEOUT_MS ?? "180000",
  10,
);
const traceId = `startup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const startedAtMs = Date.now();
const bunExecutable = process.platform === "win32" ? "bun.exe" : "bun";

const observedMetrics = new Map();
let settled = false;

const child = spawn(bunExecutable, ["run", "electron:dev"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORCE_COLOR: "0",
    STELLA_STARTUP_PROFILING: "1",
    STELLA_STARTUP_TRACE_ID: traceId,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const printChildLine = (line) => {
  console.log(line);
};

const maybeCaptureMetric = (line) => {
  const trimmed = line.trim();
  const prefixIndex = trimmed.indexOf(STARTUP_LOG_PREFIX);
  if (prefixIndex === -1) {
    return;
  }

  const jsonPayload = trimmed
    .slice(prefixIndex + STARTUP_LOG_PREFIX.length)
    .trim();

  try {
    const payload = JSON.parse(jsonPayload);
    if (payload.traceId !== traceId || typeof payload.metric !== "string") {
      return;
    }

    observedMetrics.set(payload.metric, payload);
  } catch (error) {
    console.error("[startup-measure] Failed to parse metric line:", error);
  }
};

const killTree = async (pid) => {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
};

const printSummary = () => {
  const summary = {};
  for (const [metric, payload] of observedMetrics.entries()) {
    summary[metric] = {
      atMs: payload.atMs,
      sinceStartMs: payload.atMs - startedAtMs,
      source: payload.source,
      detail: payload.detail ?? {},
    };
  }

  console.log(
    `[startup-measure] ${JSON.stringify({
      completedAtMs: Date.now(),
      requiredMetrics,
      startedAtMs,
      summary,
      traceId,
    })}`,
  );
};

const finalize = async (exitCode) => {
  if (settled) {
    return;
  }

  settled = true;
  clearTimeout(timeoutHandle);
  printSummary();
  await killTree(child.pid);
  process.exit(exitCode);
};

const hookStream = (stream) => {
  const reader = readline.createInterface({ input: stream });
  reader.on("line", (line) => {
    printChildLine(line);
    maybeCaptureMetric(line);
    if (requiredMetrics.every((metric) => observedMetrics.has(metric))) {
      void finalize(0);
    }
  });
};

hookStream(child.stdout);
hookStream(child.stderr);

child.once("exit", (code) => {
  if (settled) {
    return;
  }

  console.error(
    `[startup-measure] electron:dev exited before all required metrics were observed (code=${code ?? "null"}).`,
  );
  void finalize(1);
});

child.once("error", (error) => {
  if (settled) {
    return;
  }

  console.error("[startup-measure] Failed to start electron:dev:", error);
  void finalize(1);
});

const timeoutHandle = setTimeout(() => {
  console.error(
    `[startup-measure] Timed out after ${timeoutMs}ms waiting for ${requiredMetrics.join(", ")}.`,
  );
  void finalize(1);
}, timeoutMs);
