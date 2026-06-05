import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { resolveNativeHelperPath } from "./native-helper.js";
import { resolveStatePath } from "./shared.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";
import {
  computeStateDiff,
  formatStateDiffBlock,
  shouldUseDiffOnly,
  type StateDiff,
  type StateDiffTarget,
} from "./stella-computer-state-diff.js";

type WinFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WinElementRecord = {
  index: number;
  runtimeId?: number[];
  automationId?: string;
  name?: string;
  controlType?: string;
  localizedControlType?: string;
  className?: string;
  value?: string;
  nativeWindowHandle?: number;
  frame?: WinFrame | null;
  actions?: string[];
};

type WinSnapshot = {
  app: {
    name: string;
    bundleIdentifier?: string;
    pid: number;
  };
  windowId?: number;
  windowTitle?: string;
  windowBounds?: WinFrame | null;
  screenshotPngBase64?: string | null;
  treeLines?: string[];
  focusedSummary?: string | null;
  selectedText?: string | null;
  elements?: WinElementRecord[];
  warnings?: string[];
  capture?: {
    method?: string;
    occluded?: boolean;
    warning?: string;
  };
};

type WinHelperRequest = {
  tool: string;
  app?: string;
  element?: WinElementRecord;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  click_count?: number;
  mouse_button?: string;
  action?: string;
  direction?: string;
  pages?: number;
  text?: string;
  key?: string;
  value?: string;
  windowId?: number;
  windowBounds?: WinFrame | null;
  dispatch?: "background" | "foreground" | "auto";
  start_minimized?: boolean;
};

type WinHelperResponse = {
  ok: boolean;
  text?: string;
  error?: string;
  snapshot?: WinSnapshot;
  receipt?: {
    ok?: boolean;
    route?: string;
    lane?: string;
    background_safe?: boolean;
    cursor_moved?: boolean;
    foreground_changed?: boolean;
    session?: string;
    reason?: string;
    dispatch?: string;
    settle?: {
      observed?: boolean;
      quietMs?: number;
      waitedMs?: number;
      eventCount?: number;
      timedOut?: boolean;
      reason?: string | null;
    };
  };
  windows?: WinWindowRecord[];
};

type WinWindowRecord = {
  pid: number;
  windowId: number;
  app: string;
  title?: string;
  bounds?: WinFrame | null;
  foreground?: boolean;
  className?: string;
};

type WindowsDaemonResponse = {
  seq: number;
  status: number;
  stdout: string;
  stderr: string;
};

const stateDir = path.join(resolveStatePath(), "stella-computer");
const defaultSessionId = "manual";
const windowsHelperName = "stella-computer-helper";
const windowsHelperTimeoutMs = 30_000;
const windowsDaemonStartupBudgetMs = 2_000;

const usage = `stella-computer - control Windows apps through UI Automation and Win32 messages

Usage:
  stella-computer list-apps
  stella-computer list-windows [--json]
  stella-computer [--session ID] snapshot (--app NAME|--bundle-id ID|--pid PID|--window-id HWND) [--json]
  stella-computer [--session ID] get-state (--app NAME|--bundle-id ID|--pid PID|--window-id HWND) [--json]
  stella-computer [--session ID] launch-app <name|path|url> [--start-minimized] [--json]
  stella-computer [--session ID] click <element> [--app NAME|--window-id HWND] [--mouse-button left|right|middle] [--click-count N] [--dispatch background|foreground|auto]
  stella-computer [--session ID] fill <element> <text> [--app NAME|--window-id HWND]
  stella-computer [--session ID] secondary-action <element> <action> [--app NAME|--window-id HWND]
  stella-computer [--session ID] scroll <element> <up|down|left|right> [--app NAME|--window-id HWND] [--pages N] [--dispatch background|foreground|auto]
  stella-computer [--session ID] click-screenshot <x_px> <y_px> [--app NAME|--window-id HWND] [--mouse-button left|right|middle] [--click-count N] [--dispatch background|foreground|auto]
  stella-computer [--session ID] drag-screenshot <from_x_px> <from_y_px> <to_x_px> <to_y_px> [--app NAME|--window-id HWND] [--dispatch background|foreground|auto]
  stella-computer [--session ID] type <text> [--app NAME|--window-id HWND] [--dispatch background|foreground|auto]
  stella-computer [--session ID] press <key> [--app NAME|--window-id HWND] [--dispatch background|foreground|auto]

Notes:
  - snapshot writes element state under ~/.stella/stella-computer/sessions/<session>/windows-targets/
  - actions reuse the last snapshot for the target app and refresh it after each action
  - Windows uses the bundled stella-computer-helper.exe native helper
  - Windows keeps one helper daemon per Stella computer-use session when possible
  - the helper uses UI Automation patterns first and Win32 window messages as fallback
  - --dispatch background is strict, foreground uses real input, auto chooses foreground for known background-drop cases
  - SetFocus and UIA text fallback are opt-in via STELLA_COMPUTER_WINDOWS_ALLOW_* env flags
`;

const isTruthyEnv = (value: string | undefined) =>
  typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());

const stripOptionValue = (args: string[], flag: string) => {
  const nextArgs: string[] = [];
  let value: string | null = null;
  let missingValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === flag) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        missingValue = true;
        continue;
      }
      value = next;
      index += 1;
      continue;
    }
    nextArgs.push(arg);
  }
  return { value, args: nextArgs, missingValue };
};

const getSessionId = (sessionOverride?: string | null) =>
  sanitizeStellaComputerSessionId(sessionOverride) ??
  sanitizeStellaComputerSessionId(process.env.STELLA_COMPUTER_SESSION) ??
  defaultSessionId;

const sessionDir = (sessionId: string) =>
  path.join(stateDir, "sessions", sessionId, "windows-targets");

const normalizeTargetKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "default";

const targetStatePath = (sessionId: string, app: string) =>
  path.join(
    sessionDir(sessionId),
    normalizeTargetKey(app),
    "last-snapshot.json",
  );

const targetScreenshotPath = (sessionId: string, app: string) =>
  path.join(
    sessionDir(sessionId),
    normalizeTargetKey(app),
    "last-screenshot.png",
  );

const windowAlias = (windowId: number) => `hwnd:${Math.trunc(windowId)}`;

const windowsDaemonDir = (sessionId: string) =>
  path.join(stateDir, "sessions", sessionId, "windows-daemon");

const windowsDaemonPidPath = (sessionId: string) =>
  path.join(windowsDaemonDir(sessionId), "helper.pid");

const windowsDaemonPipeName = (sessionId: string) =>
  `\\\\.\\pipe\\stella-computer-${createHash("sha1")
    .update(sessionId)
    .digest("hex")
    .slice(0, 24)}`;

const readPidFile = (filePath: string): number | null => {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const pidIsRunning = (pid: number | null): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killProcess = (pid: number | null) => {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore stale pid files
  }
};

const helperNewerThanDaemon = (helperPath: string, pidPath: string) => {
  try {
    return fs.statSync(helperPath).mtimeMs > fs.statSync(pidPath).mtimeMs + 500;
  } catch {
    return false;
  }
};

const connectWindowsPipe = (
  pipeName: string,
  timeoutMs: number,
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `Windows stella-computer daemon connection timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const connectWindowsPipeWithRetry = async (
  pipeName: string,
  budgetMs: number,
): Promise<net.Socket> => {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await connectWindowsPipe(pipeName, Math.min(150, budgetMs));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Windows stella-computer daemon connection failed");
};

const ensureWindowsDaemon = async (sessionId: string): Promise<boolean> => {
  if (process.platform !== "win32") return false;

  const helperPath = resolveNativeHelperPath(windowsHelperName);
  if (!helperPath) return false;

  const pidPath = windowsDaemonPidPath(sessionId);
  const pipeName = windowsDaemonPipeName(sessionId);
  const existingPid = readPidFile(pidPath);
  if (existingPid && pidIsRunning(existingPid)) {
    if (helperNewerThanDaemon(helperPath, pidPath)) {
      killProcess(existingPid);
    } else {
      try {
        const socket = await connectWindowsPipe(pipeName, 150);
        socket.end();
        return true;
      } catch {
        killProcess(existingPid);
      }
    }
  }

  fs.mkdirSync(windowsDaemonDir(sessionId), { recursive: true });
  fs.rmSync(pidPath, { force: true });
  const child = spawn(
    helperPath,
    ["daemon", "--pipe-name", pipeName, "--pid-file", pidPath],
    {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();

  const deadline = Date.now() + windowsDaemonStartupBudgetMs;
  while (Date.now() < deadline) {
    const pid = readPidFile(pidPath);
    if (pid && pidIsRunning(pid)) {
      try {
        const socket = await connectWindowsPipe(pipeName, 100);
        socket.end();
        return true;
      } catch {
        // Keep waiting until the named-pipe server accepts connections.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const readSnapshot = (sessionId: string, app: string): WinSnapshot | null => {
  try {
    return JSON.parse(
      fs.readFileSync(targetStatePath(sessionId, app), "utf8"),
    ) as WinSnapshot;
  } catch {
    return null;
  }
};

const parseWindowIdValue = (value: string | null): number | null => {
  if (!value) return null;
  const normalized = value.trim().replace(/^hwnd:/i, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const rememberSnapshot = (
  sessionId: string,
  app: string,
  snapshot: WinSnapshot,
) => {
  const aliases = new Set(
    [
      app,
      snapshot.app.name,
      snapshot.app.bundleIdentifier,
      String(snapshot.app.pid),
      snapshot.windowId ? String(snapshot.windowId) : null,
      snapshot.windowId ? windowAlias(snapshot.windowId) : null,
    ].filter((value): value is string => Boolean(value)),
  );

  const png = snapshot.screenshotPngBase64
    ? Buffer.from(snapshot.screenshotPngBase64, "base64")
    : null;

  for (const alias of aliases) {
    const statePath = targetStatePath(sessionId, alias);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2));
    if (png) {
      fs.writeFileSync(targetScreenshotPath(sessionId, alias), png);
    }
  }
};

const runWindowsHelper = async (
  sessionId: string,
  request: WinHelperRequest,
): Promise<WinHelperResponse> => {
  const daemonReady = await ensureWindowsDaemon(sessionId);
  if (!daemonReady) {
    throw new Error(
      `Windows stella-computer daemon failed to start after ${windowsDaemonStartupBudgetMs}ms`,
    );
  }

  const pipeName = windowsDaemonPipeName(sessionId);
  const seq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = `${JSON.stringify({ seq, operation: request })}\n`;

  const socket = await connectWindowsPipeWithRetry(pipeName, 1_000);
  const responseText = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const settle = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      killProcess(readPidFile(windowsDaemonPidPath(sessionId)));
      settle(
        new Error(
          `Windows stella-computer daemon timed out after ${windowsHelperTimeoutMs}ms`,
        ),
      );
    }, windowsHelperTimeoutMs);

    socket.write(payload);
    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on("end", () => {
      settle(null, Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", (error) => {
      settle(
        error instanceof Error
          ? new Error(
              `Windows stella-computer daemon connection failed: ${error.message}`,
            )
          : new Error("Windows stella-computer daemon connection failed"),
      );
    });
  });

  let envelope: WindowsDaemonResponse;
  try {
    envelope = JSON.parse(responseText) as WindowsDaemonResponse;
  } catch (error) {
    throw new Error(
      `Windows stella-computer daemon returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }: ${responseText.trim()}`,
    );
  }
  if (envelope.seq !== seq) {
    throw new Error(
      "Windows stella-computer daemon returned a mismatched response sequence.",
    );
  }
  if (envelope.status !== 0) {
    throw new Error(
      envelope.stderr.trim() ||
        envelope.stdout.trim() ||
        `Windows stella-computer daemon exited request ${envelope.status}`,
    );
  }

  try {
    return JSON.parse(envelope.stdout) as WinHelperResponse;
  } catch (error) {
    throw new Error(
      `Windows stella-computer helper returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }: ${envelope.stdout.trim() || envelope.stderr.trim()}`,
    );
  }
};

const appFromSnapshotArgs = (args: string[]) => {
  let nextArgs = args;
  const app = stripOptionValue(nextArgs, "--app");
  nextArgs = app.args;
  const bundle = stripOptionValue(nextArgs, "--bundle-id");
  nextArgs = bundle.args;
  const pid = stripOptionValue(nextArgs, "--pid");
  nextArgs = pid.args;
  const window = stripOptionValue(nextArgs, "--window-id");
  nextArgs = window.args;
  if (
    app.missingValue ||
    bundle.missingValue ||
    pid.missingValue ||
    window.missingValue
  ) {
    throw new Error(
      "--app, --bundle-id, --pid, and --window-id require a value.",
    );
  }
  const windowId = parseWindowIdValue(window.value);
  if (window.value && !windowId) {
    throw new Error(`Invalid --window-id value: ${window.value}`);
  }
  const target =
    app.value ??
    bundle.value ??
    pid.value ??
    (windowId ? windowAlias(windowId) : null);
  if (!target) {
    throw new Error(
      "Windows stella-computer requires --app, --bundle-id, --pid, or --window-id.",
    );
  }
  return { app: target, windowId: windowId ?? undefined, args: nextArgs };
};

const appFromActionArgs = (sessionId: string, args: string[]) => {
  let nextArgs = args;
  const app = stripOptionValue(nextArgs, "--app");
  nextArgs = app.args;
  const bundle = stripOptionValue(nextArgs, "--bundle-id");
  nextArgs = bundle.args;
  const pid = stripOptionValue(nextArgs, "--pid");
  nextArgs = pid.args;
  const window = stripOptionValue(nextArgs, "--window-id");
  nextArgs = window.args;
  if (
    app.missingValue ||
    bundle.missingValue ||
    pid.missingValue ||
    window.missingValue
  ) {
    throw new Error(
      "--app, --bundle-id, --pid, and --window-id require a value.",
    );
  }
  const windowId = parseWindowIdValue(window.value);
  if (window.value && !windowId) {
    throw new Error(`Invalid --window-id value: ${window.value}`);
  }
  const target =
    app.value ??
    bundle.value ??
    pid.value ??
    (windowId ? windowAlias(windowId) : null);
  if (target) {
    return { app: target, windowId: windowId ?? undefined, args: nextArgs };
  }

  const candidates: string[] = [];
  const root = sessionDir(sessionId);
  try {
    for (const entry of fs.readdirSync(root)) {
      const statePath = path.join(root, entry, "last-snapshot.json");
      if (fs.existsSync(statePath)) {
        candidates.push(statePath);
      }
    }
  } catch {
    // no cached snapshots
  }
  if (candidates.length === 1) {
    const snapshot = JSON.parse(
      fs.readFileSync(candidates[0]!, "utf8"),
    ) as WinSnapshot;
    return {
      app: snapshot.app.bundleIdentifier ?? snapshot.app.name,
      windowId: snapshot.windowId,
      args: nextArgs,
    };
  }
  throw new Error(
    "Action commands require --app on Windows unless the session has exactly one cached snapshot.",
  );
};

const getOptionValue = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
};

const getDispatchOption = (
  args: string[],
): "background" | "foreground" | "auto" => {
  const value = getOptionValue(args, "--dispatch") ?? "background";
  if (value === "background" || value === "foreground" || value === "auto") {
    return value;
  }
  throw new Error(`Invalid --dispatch value: ${value}`);
};

const splitWindowsArgs = (args: string[]) => {
  const positionals: string[] = [];
  const valueOptions = new Set([
    "--app",
    "--bundle-id",
    "--pid",
    "--window-id",
    "--mouse-button",
    "--click-count",
    "--pages",
    "--state",
    "--dispatch",
  ]);
  const booleanOptions = new Set([
    "--allow-hid",
    "--raise",
    "--no-raise",
    "--no-screenshot",
    "--no-inline-screenshot",
    "--no-overlay",
    "--json",
    "--start-minimized",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (booleanOptions.has(arg)) {
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
};

const lookupElement = (snapshot: WinSnapshot, elementIndex: string) => {
  const index = Number(elementIndex);
  if (!Number.isInteger(index)) {
    throw new Error(`unknown element_index ${JSON.stringify(elementIndex)}`);
  }
  const record = snapshot.elements?.find((element) => element.index === index);
  if (!record) {
    throw new Error(`unknown element_index ${JSON.stringify(elementIndex)}`);
  }
  return record;
};

const requiredSnapshot = (sessionId: string, app: string) => {
  const snapshot = readSnapshot(sessionId, app);
  if (!snapshot) {
    throw new Error(
      `No app state is available for ${app}. Run stella-computer snapshot before action commands.`,
    );
  }
  return snapshot;
};

const frameImageBytes = (snapshot: WinSnapshot) =>
  snapshot.screenshotPngBase64
    ? Buffer.from(snapshot.screenshotPngBase64, "base64")
    : null;

const formatScreenshotMarker = (
  sessionId: string,
  app: string,
  snapshot: WinSnapshot,
) => {
  if (!snapshot.screenshotPngBase64) return "";
  const bytes = frameImageBytes(snapshot);
  const path = targetScreenshotPath(sessionId, app);
  const dims = snapshot.windowBounds
    ? ` ${Math.round(snapshot.windowBounds.width)}x${Math.round(snapshot.windowBounds.height)}`
    : "";
  const sizeKb = bytes ? ` ${(bytes.byteLength / 1024).toFixed(0)}KB` : "";
  return `[stella-attach-image]${dims}${sizeKb} inline=image/png ${path}\n`;
};

const winSnapshotLines = (snapshot: WinSnapshot) => {
  const lines: string[] = ["<app_state>"];
  const appRef = snapshot.app.bundleIdentifier || snapshot.app.name;
  lines.push(`App=${appRef} (pid ${snapshot.app.pid})`);
  const title = snapshot.windowTitle || snapshot.app.name;
  lines.push(`Window: "${title}", App: ${snapshot.app.name}.`);
  if (snapshot.capture?.method) {
    const warning = snapshot.capture.warning
      ? ` (${snapshot.capture.warning})`
      : "";
    lines.push(`Screenshot capture: ${snapshot.capture.method}${warning}`);
  }
  for (const warning of snapshot.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  for (const line of snapshot.treeLines ?? []) {
    lines.push(line);
  }
  if (snapshot.selectedText) {
    lines.push("", `Selected text: [${snapshot.selectedText}]`);
  } else if (snapshot.focusedSummary) {
    lines.push("", `The focused UI element is ${snapshot.focusedSummary}.`);
  }
  lines.push("</app_state>");
  return lines;
};

const winDiffTargetFromSnapshot = (
  snapshot: WinSnapshot,
  lineCount: number,
): StateDiffTarget => ({
  appName: snapshot.app.name,
  bundleId: snapshot.app.bundleIdentifier ?? null,
  pid: snapshot.app.pid,
  windowTitle: snapshot.windowTitle ?? null,
  windowId: snapshot.windowId ?? null,
  capturedAt: null,
  nodeCount: snapshot.elements?.length ?? snapshot.treeLines?.length ?? null,
  lineCount,
});

const winSnapshotDiff = (
  previous: WinSnapshot | null,
  current: WinSnapshot,
): StateDiff => {
  const previousLines = previous ? winSnapshotLines(previous) : null;
  const currentLines = winSnapshotLines(current);
  return computeStateDiff({
    previousLines,
    currentLines,
    previousTarget: previous
      ? winDiffTargetFromSnapshot(previous, previousLines?.length ?? 0)
      : null,
    currentTarget: winDiffTargetFromSnapshot(current, currentLines.length),
  });
};

const formatSnapshot = (
  sessionId: string,
  app: string,
  snapshot: WinSnapshot,
) => {
  process.stdout.write(`${winSnapshotLines(snapshot).join("\n")}\n`);
  process.stdout.write(formatScreenshotMarker(sessionId, app, snapshot));
};

const formatActionReceipt = (
  receipt: WinHelperResponse["receipt"] | undefined,
  fallbackDispatch: string | undefined,
) => {
  if (!receipt) return;
  process.stdout.write(
    `Action receipt: route=${receipt.route ?? "unknown"} dispatch=${
      receipt.dispatch ?? fallbackDispatch ?? "background"
    } background_safe=${
      receipt.background_safe === true ? "true" : "false"
    } cursor_moved=${receipt.cursor_moved === true ? "true" : "false"} foreground_changed=${
      receipt.foreground_changed === true ? "true" : "false"
    }\n`,
  );
  if (receipt.settle) {
    const settle = receipt.settle;
    const source = settle.observed ? "UIA quiet" : "fixed post-action wait";
    const reason = settle.reason ? ` reason=${settle.reason}` : "";
    process.stdout.write(
      `Action settle: ${source}; waited=${settle.waitedMs ?? 0}ms quiet=${settle.quietMs ?? 0}ms events=${settle.eventCount ?? 0} timed_out=${settle.timedOut === true ? "true" : "false"}${reason}\n`,
    );
  }
};

const emitJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const formatWindowRecord = (window: WinWindowRecord) => {
  const title = window.title?.trim() || "untitled";
  const bounds = window.bounds
    ? ` bounds=${Math.round(window.bounds.x)},${Math.round(window.bounds.y)} ${Math.round(
        window.bounds.width,
      )}x${Math.round(window.bounds.height)}`
    : "";
  const foreground = window.foreground ? " foreground" : "";
  const className = window.className ? ` class=${window.className}` : "";
  return `${window.app} -- ${title} [pid=${window.pid}, window-id=${window.windowId}, target=${windowAlias(
    window.windowId,
  )}${bounds}${foreground}${className}]`;
};

const formatWindowsText = (windows: readonly WinWindowRecord[] | undefined) => {
  if (!windows?.length) {
    return "No visible top-level windows are available to this Windows runtime.";
  }
  return windows.map(formatWindowRecord).join("\n");
};

const runSnapshot = async (
  sessionId: string,
  app: string,
  jsonMode: boolean,
  windowId?: number,
) => {
  const previous = readSnapshot(sessionId, app);
  const response = await runWindowsHelper(sessionId, {
    tool: "get_app_state",
    app,
    windowId,
  });
  if (!response.ok || !response.snapshot) {
    throw new Error(
      response.error || "Windows runtime did not return an app snapshot.",
    );
  }
  const stateDiff = winSnapshotDiff(previous, response.snapshot);
  rememberSnapshot(sessionId, app, response.snapshot);
  if (jsonMode) {
    emitJson({ ...response.snapshot, stateDiff });
  } else {
    formatSnapshot(sessionId, app, response.snapshot);
  }
};

const runAction = async (
  sessionId: string,
  app: string,
  request: WinHelperRequest,
  jsonMode: boolean,
) => {
  const previous = readSnapshot(sessionId, app);
  const response = await runWindowsHelper(sessionId, request);
  if (!response.ok || !response.snapshot) {
    throw new Error(
      response.error || "Windows runtime did not return an app snapshot.",
    );
  }
  const stateDiff = winSnapshotDiff(previous, response.snapshot);
  rememberSnapshot(sessionId, app, response.snapshot);
  if (jsonMode) {
    emitJson({
      receipt: response.receipt ?? null,
      snapshot: response.snapshot,
      stateDiff,
    });
  } else {
    formatActionReceipt(response.receipt, request.dispatch);
    process.stdout.write(`${request.tool} completed.\n`);
    if (shouldUseDiffOnly(stateDiff)) {
      process.stdout.write(formatStateDiffBlock(stateDiff));
      process.stdout.write(formatScreenshotMarker(sessionId, app, response.snapshot));
    } else {
      process.stdout.write(formatStateDiffBlock(stateDiff));
      formatSnapshot(sessionId, app, response.snapshot);
    }
  }
};

export const runWindowsStellaComputer = async (
  argv: string[],
  jsonMode: boolean,
  sessionOverride?: string | null,
) => {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  const sessionId = getSessionId(sessionOverride);
  const command = argv[0]!;
  const args = argv.slice(1);

  if (command === "list-apps") {
    const response = await runWindowsHelper(sessionId, { tool: "list_apps" });
    if (!response.ok) {
      throw new Error(response.error || "Windows runtime failed to list apps.");
    }
    process.stdout.write(
      response.text?.trimEnd() ||
        "No running top-level apps are visible to this Windows runtime.",
    );
    process.stdout.write("\n");
    return 0;
  }

  if (command === "list-windows") {
    const response = await runWindowsHelper(sessionId, {
      tool: "list_windows",
    });
    if (!response.ok) {
      throw new Error(
        response.error || "Windows runtime failed to list windows.",
      );
    }
    if (jsonMode) {
      emitJson({ windows: response.windows ?? [] });
    } else {
      process.stdout.write(
        response.text?.trimEnd() || formatWindowsText(response.windows),
      );
      process.stdout.write("\n");
    }
    return 0;
  }

  if (command === "snapshot" || command === "get-state") {
    const target = appFromSnapshotArgs(args);
    await runSnapshot(sessionId, target.app, jsonMode, target.windowId);
    return 0;
  }

  if (command === "launch-app") {
    const positionals = splitWindowsArgs(args);
    const app = positionals.join(" ").trim();
    if (!app) throw new Error("launch-app requires an app name, path, or URL.");
    const response = await runWindowsHelper(sessionId, {
      tool: "launch_app",
      app,
      start_minimized: args.includes("--start-minimized"),
    });
    if (!response.ok) {
      throw new Error(
        response.error || "Windows runtime failed to launch app.",
      );
    }
    if (response.snapshot) {
      rememberSnapshot(sessionId, app, response.snapshot);
    }
    if (jsonMode) {
      emitJson(response);
    } else {
      if (response.text?.trim()) {
        process.stdout.write(`${response.text.trimEnd()}\n`);
      } else {
        process.stdout.write(`${formatWindowsText(response.windows)}\n`);
      }
      if (response.snapshot) {
        formatSnapshot(sessionId, app, response.snapshot);
      }
    }
    return 0;
  }

  if (command === "click") {
    const target = appFromActionArgs(sessionId, args);
    const element = splitWindowsArgs(target.args)[0];
    if (!element) throw new Error("click requires an element index.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    const record = lookupElement(snapshot, element);
    const button = getOptionValue(target.args, "--mouse-button") ?? "left";
    const countRaw = Number(
      getOptionValue(target.args, "--click-count") ?? "1",
    );
    await runAction(
      sessionId,
      target.app,
      {
        tool: "click",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        element: record,
        mouse_button: button,
        click_count: Number.isFinite(countRaw)
          ? Math.max(1, Math.trunc(countRaw))
          : 1,
        windowBounds: snapshot.windowBounds ?? null,
        dispatch: getDispatchOption(target.args),
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "click-screenshot") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    if (positionals.length < 2)
      throw new Error("click-screenshot requires x_px and y_px.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    const x = Number(positionals[0]);
    const y = Number(positionals[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("click-screenshot coordinates must be finite numbers.");
    }
    const button = getOptionValue(target.args, "--mouse-button") ?? "left";
    const countRaw = Number(
      getOptionValue(target.args, "--click-count") ?? "1",
    );
    await runAction(
      sessionId,
      target.app,
      {
        tool: "click",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        x,
        y,
        mouse_button: button,
        click_count: Number.isFinite(countRaw)
          ? Math.max(1, Math.trunc(countRaw))
          : 1,
        windowBounds: snapshot.windowBounds ?? null,
        dispatch: getDispatchOption(target.args),
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "drag-screenshot") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    if (positionals.length < 4) {
      throw new Error(
        "drag-screenshot requires from_x_px, from_y_px, to_x_px, and to_y_px.",
      );
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const [fromX, fromY, toX, toY] = positionals.slice(0, 4).map(Number);
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      throw new Error("drag-screenshot coordinates must be finite numbers.");
    }
    await runAction(
      sessionId,
      target.app,
      {
        tool: "drag",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        from_x: fromX,
        from_y: fromY,
        to_x: toX,
        to_y: toY,
        windowBounds: snapshot.windowBounds ?? null,
        dispatch: getDispatchOption(target.args),
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "fill") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, ...textParts] = positionals;
    if (!element) throw new Error("fill requires an element index.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(
      sessionId,
      target.app,
      {
        tool: "set_value",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        element: lookupElement(snapshot, element),
        value: textParts.join(" "),
        windowBounds: snapshot.windowBounds ?? null,
      },
      jsonMode,
    );
    return 0;
  }

  if (
    command === "secondary-action" ||
    command === "perform-secondary-action"
  ) {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, action] = positionals;
    if (!element || !action)
      throw new Error("secondary-action requires an element index and action.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(
      sessionId,
      target.app,
      {
        tool: "perform_secondary_action",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        element: lookupElement(snapshot, element),
        action,
        windowBounds: snapshot.windowBounds ?? null,
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "scroll") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, direction] = positionals;
    if (!element || !direction)
      throw new Error("scroll requires an element index and direction.");
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`);
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const pages = Number(getOptionValue(target.args, "--pages") ?? "1");
    await runAction(
      sessionId,
      target.app,
      {
        tool: "scroll",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        element: lookupElement(snapshot, element),
        direction,
        pages: Number.isFinite(pages) && pages > 0 ? pages : 1,
        windowBounds: snapshot.windowBounds ?? null,
        dispatch: getDispatchOption(target.args),
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "type") {
    const target = appFromActionArgs(sessionId, args);
    const text = splitWindowsArgs(target.args).join(" ");
    if (!text) throw new Error("type requires text.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(
      sessionId,
      target.app,
      {
        tool: "type_text",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        text,
        dispatch: getDispatchOption(target.args),
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "press") {
    const target = appFromActionArgs(sessionId, args);
    const key = splitWindowsArgs(target.args)[0];
    if (!key) throw new Error("press requires a key.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(
      sessionId,
      target.app,
      {
        tool: "press_key",
        app: target.app,
        windowId: target.windowId ?? snapshot.windowId,
        key,
        dispatch: getDispatchOption(target.args),
      },
      jsonMode,
    );
    return 0;
  }

  if (command === "doctor") {
    const response = await runWindowsHelper(sessionId, { tool: "doctor" });
    if (!response.ok) {
      throw new Error(response.error || "Windows runtime doctor failed.");
    }
    process.stdout.write(
      [
        response.text?.trimEnd() ||
          "Windows runtime: stella-computer-helper.exe",
        "Action routes: UI Automation patterns first, then Win32 window messages for background-safe fallback.",
        `App launch opt-in: ${isTruthyEnv(process.env.STELLA_COMPUTER_WINDOWS_ALLOW_APP_LAUNCH) ? "enabled" : "disabled"}`,
        `Focus actions opt-in: ${isTruthyEnv(process.env.STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS) ? "enabled" : "disabled"}`,
        `UIA text fallback opt-in: ${isTruthyEnv(process.env.STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK) ? "enabled" : "disabled"}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage}`);
};
