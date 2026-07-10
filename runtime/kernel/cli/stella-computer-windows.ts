import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { resolveNativeHelperPath } from "./native-helper.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";
import {
  getComputerExecutionEnv,
  getComputerExecutionSignal,
  writeComputerStdout,
} from "../computer-use/execution-context.js";
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
  screenshot?: {
    widthPx?: number | null;
    heightPx?: number | null;
  } | null;
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
  appInstructions?: string | null;
  revision?: number;
  materializedRevision?: number;
  cacheHit?: boolean;
  cacheKey?: string;
  pendingActionCount?: number;
  screenshotPolicy?: ScreenshotPolicy;
  reliability?: {
    uiaEventsObserved?: boolean;
    elementCacheValidated?: boolean;
    perMonitorDpiAware?: boolean;
    screenshotLongEdgeCapPx?: number;
    settleWaitedMs?: number;
    settleEventCount?: number;
    settleTimedOut?: boolean;
    settleBaselineRevision?: number;
    settleFinalRevision?: number;
  };
};

type ScreenshotPolicy = "auto" | "always" | "never";

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
  prefix?: string;
  suffix?: string;
  selection?: "text" | "cursor-before" | "cursor-after";
  windowId?: number;
  windowBounds?: WinFrame | null;
  dispatch?: "background" | "foreground" | "auto";
  start_minimized?: boolean;
  defer_observation?: boolean;
  screenshot_policy?: ScreenshotPolicy;
  screenshot_width?: number;
  screenshot_height?: number;
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
      baselineRevision?: number;
      finalRevision?: number;
      pendingActionCount?: number;
    };
  };
  revision?: number;
  deferred?: boolean;
  windows?: WinWindowRecord[];
};

type WindowsTargetRecord = {
  key: string;
  appName: string;
  bundleIdentifier?: string | null;
  pid: number;
  windowId?: number | null;
  statePath: string;
  screenshotPath: string;
  updatedAt: string;
};

type WindowsTargetRegistry = {
  activeTargetKey?: string | null;
  aliases: Record<string, string>;
  targets: Record<string, WindowsTargetRecord>;
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

const defaultSessionId = "manual";
const windowsHelperName = "stella-computer-helper";
const windowsHelperTimeoutMs = 30_000;
const windowsDaemonStartupBudgetMs = 2_000;
const sessionPruneIntervalMs = 24 * 60 * 60 * 1000;
const sessionRetentionMs = 24 * 60 * 60 * 1000;

const windowsStateDir = () => {
  const configured = getComputerExecutionEnv().STELLA_DATA_DIR;
  const root = configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".stella");
  return path.join(root, "stella-computer");
};

const windowsSessionsRoot = () => path.join(windowsStateDir(), "sessions");
const windowsPruneStatePath = () =>
  path.join(windowsStateDir(), "last-prune.json");

const usage = `stella-computer - control Windows apps through UI Automation and Win32 messages

Usage:
  stella-computer list-apps
  stella-computer list-windows [--json]
  stella-computer [--session ID] snapshot (--app NAME|--bundle-id ID|--pid PID|--window-id HWND) [--screenshot-policy auto|always|never] [--disable-diff] [--json]
  stella-computer [--session ID] get-state (--app NAME|--bundle-id ID|--pid PID|--window-id HWND) [--screenshot-policy auto|always|never] [--disable-diff] [--json]
  stella-computer [--session ID] launch-app <name|path|url> [--start-minimized] [--json]
  stella-computer [--session ID] click <element> [--app NAME|--window-id HWND] [--mouse-button left|right|middle] [--click-count N] [--dispatch background|foreground|auto] [--defer-observation]
  stella-computer [--session ID] fill <element> <text> [--app NAME|--window-id HWND] [--defer-observation]
  stella-computer [--session ID] select-text <element> <text> [--prefix TEXT] [--suffix TEXT] [--selection text|cursor-before|cursor-after] [--app NAME|--window-id HWND] [--defer-observation]
  stella-computer [--session ID] secondary-action <element> <action> [--app NAME|--window-id HWND]
  stella-computer [--session ID] scroll <element> <up|down|left|right> [--app NAME|--window-id HWND] [--pages N] [--dispatch background|foreground|auto]
  stella-computer [--session ID] click-screenshot <x_px> <y_px> [--app NAME|--window-id HWND] [--mouse-button left|right|middle] [--click-count N] [--dispatch background|foreground|auto]
  stella-computer [--session ID] drag-screenshot <from_x_px> <from_y_px> <to_x_px> <to_y_px> [--app NAME|--window-id HWND] [--dispatch background|foreground|auto]
  stella-computer [--session ID] type <text> [--app NAME|--window-id HWND] [--dispatch background|foreground|auto]
  stella-computer [--session ID] press <key> [--app NAME|--window-id HWND] [--dispatch background|foreground|auto]

Notes:
  - snapshot writes element state under ~/.stella/stella-computer/sessions/<session>/windows-targets/
  - actions reuse the last snapshot for the target app and refresh it unless --defer-observation is set
  - deferred actions acknowledge immediately; the next get-state settles and materializes the final state
  - --screenshot-policy auto captures only when the deferred sequence needs visual context
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
  sanitizeStellaComputerSessionId(
    getComputerExecutionEnv().STELLA_COMPUTER_SESSION,
  ) ??
  defaultSessionId;

const sessionDir = (sessionId: string) =>
  path.join(windowsSessionsRoot(), sessionId, "windows-targets");

const targetRegistryPath = (sessionId: string) =>
  path.join(sessionDir(sessionId), "targets.json");

const normalizeTargetKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "default";

const targetStatePathForKey = (sessionId: string, key: string) =>
  path.join(sessionDir(sessionId), key, "last-snapshot.json");

const targetScreenshotPathForKey = (sessionId: string, key: string) =>
  path.join(sessionDir(sessionId), key, "last-screenshot.png");

const windowAlias = (windowId: number) => `hwnd:${Math.trunc(windowId)}`;

const windowsDaemonDir = (sessionId: string) =>
  path.join(windowsSessionsRoot(), sessionId, "windows-daemon");

const windowsDaemonPidPath = (sessionId: string) =>
  path.join(windowsDaemonDir(sessionId), "helper.pid");

const windowsDaemonPipeName = (sessionId: string) =>
  `\\\\.\\pipe\\stella-computer-${createHash("sha1")
    .update(sessionId)
    .digest("hex")
    .slice(0, 24)}`;

const emptyTargetRegistry = (): WindowsTargetRegistry => ({
  activeTargetKey: null,
  aliases: {},
  targets: {},
});

const readTargetRegistry = (sessionId: string): WindowsTargetRegistry => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(targetRegistryPath(sessionId), "utf8"),
    ) as Partial<WindowsTargetRegistry>;
    return {
      activeTargetKey: parsed.activeTargetKey ?? null,
      aliases: parsed.aliases ?? {},
      targets: parsed.targets ?? {},
    };
  } catch {
    return emptyTargetRegistry();
  }
};

const writeJsonAtomic = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
};

const writeTargetRegistry = (
  sessionId: string,
  registry: WindowsTargetRegistry,
) => writeJsonAtomic(targetRegistryPath(sessionId), registry);

const normalizedAlias = (value: string) => normalizeTargetKey(value);

export const canonicalWindowsTargetKey = (
  snapshot: Pick<WinSnapshot, "windowId" | "app">,
) =>
  snapshot.windowId
    ? `window-${Math.trunc(snapshot.windowId)}`
    : `pid-${Math.trunc(snapshot.app.pid)}`;

const resolveTargetRecord = (
  sessionId: string,
  app?: string | null,
): WindowsTargetRecord | null => {
  const registry = readTargetRegistry(sessionId);
  const key = app
    ? registry.aliases[normalizedAlias(app)]
    : registry.activeTargetKey;
  return key ? (registry.targets[key] ?? null) : null;
};

const targetStatePath = (sessionId: string, app: string) =>
  resolveTargetRecord(sessionId, app)?.statePath ??
  targetStatePathForKey(sessionId, normalizeTargetKey(app));

const targetScreenshotPath = (sessionId: string, app: string) =>
  resolveTargetRecord(sessionId, app)?.screenshotPath ??
  targetScreenshotPathForKey(sessionId, normalizeTargetKey(app));

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

const stopWindowsDaemonUnlocked = (sessionId: string) => {
  const pidPath = windowsDaemonPidPath(sessionId);
  const pid = readPidFile(pidPath);
  killProcess(pid);
  fs.rmSync(pidPath, { force: true });
  return pid !== null;
};

const windowsSessionTails = new Map<string, Promise<void>>();

const windowsCancellationError = (signal?: AbortSignal) => {
  const reason =
    signal?.reason instanceof Error
      ? `: ${signal.reason.message}`
      : signal?.reason
        ? `: ${String(signal.reason)}`
        : "";
  const error = new Error(`Windows stella-computer request cancelled${reason}`);
  error.name = "AbortError";
  return error;
};

const waitWithSignal = async <T>(promise: Promise<T>, signal?: AbortSignal) => {
  if (!signal) return await promise;
  if (signal.aborted) throw windowsCancellationError(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(windowsCancellationError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const delayWithSignal = (ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) return Promise.reject(windowsCancellationError(signal));
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(windowsCancellationError(signal));
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const withWindowsComputerSessionLock = async <T>(
  sessionId: string,
  operation: () => Promise<T>,
  signal: AbortSignal | null | undefined = getComputerExecutionSignal(),
): Promise<T> => {
  const activeSignal = signal ?? undefined;
  const previous = windowsSessionTails.get(sessionId) ?? Promise.resolve();
  const turn = previous.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = turn.then(() => gate);
  windowsSessionTails.set(sessionId, tail);

  try {
    await waitWithSignal(turn, activeSignal);
    if (activeSignal?.aborted) throw windowsCancellationError(activeSignal);
    return await operation();
  } finally {
    release();
    if (windowsSessionTails.get(sessionId) === tail) {
      void tail.finally(() => {
        if (windowsSessionTails.get(sessionId) === tail) {
          windowsSessionTails.delete(sessionId);
        }
      });
    }
  }
};

export const cleanupWindowsStellaComputerSessionDaemon = async (
  sessionOverride?: string | null,
) => {
  const sessionId = getSessionId(sessionOverride);
  return await withWindowsComputerSessionLock(
    sessionId,
    async () => stopWindowsDaemonUnlocked(sessionId),
    null,
  );
};

const safeDirectoryEntries = (directory: string) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const latestMtimeMs = (targetPath: string): number => {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetPath);
  } catch {
    return 0;
  }
  let newest = stats.mtimeMs;
  if (stats.isDirectory()) {
    for (const entry of safeDirectoryEntries(targetPath)) {
      newest = Math.max(
        newest,
        latestMtimeMs(path.join(targetPath, entry.name)),
      );
    }
  }
  return newest;
};

const pruneWindowsSessions = (activeSessionId: string) => {
  const now = Date.now();
  const pruneStatePath = windowsPruneStatePath();
  const sessionsRoot = windowsSessionsRoot();
  try {
    const previous = JSON.parse(fs.readFileSync(pruneStatePath, "utf8")) as {
      prunedAtMs?: number;
    };
    if (now - (previous.prunedAtMs ?? 0) < sessionPruneIntervalMs) return;
  } catch {
    // Missing maintenance state means pruning is due.
  }
  try {
    writeJsonAtomic(pruneStatePath, { prunedAtMs: now });
  } catch {
    return;
  }
  for (const entry of safeDirectoryEntries(sessionsRoot)) {
    if (!entry.isDirectory() || entry.name === activeSessionId) continue;
    const sessionPath = path.join(sessionsRoot, entry.name);
    const daemonPid = readPidFile(
      path.join(sessionPath, "windows-daemon", "helper.pid"),
    );
    const automationPid = readPidFile(path.join(sessionPath, "automation.pid"));
    if (pidIsRunning(daemonPid) || pidIsRunning(automationPid)) continue;
    const newest = latestMtimeMs(sessionPath);
    if (newest > 0 && now - newest > sessionRetentionMs) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }
};

const helperNewerThanDaemon = (helperPath: string, pidPath: string) => {
  try {
    return fs.statSync(helperPath).mtimeMs > fs.statSync(pidPath).mtimeMs + 500;
  } catch {
    return false;
  }
};

const ignoreWindowsPipeError = () => undefined;

export const connectWindowsPipe = (
  pipeName: string,
  timeoutMs: number,
  signal = getComputerExecutionSignal(),
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(windowsCancellationError(signal));
      return;
    }

    let socket: net.Socket;
    try {
      socket = net.createConnection(pipeName);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const cleanup = (removeErrorListener: boolean) => {
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      if (removeErrorListener) socket.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup(true);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        // Guard the handoff between connection and request handler installation.
        socket.on("error", ignoreWindowsPipeError);
        resolve(socket);
      }
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Windows stella-computer daemon connection timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(windowsCancellationError(signal));
    socket.once("connect", onConnect);
    socket.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const connectWindowsPipeWithRetry = async (
  pipeName: string,
  budgetMs: number,
  signal = getComputerExecutionSignal(),
): Promise<net.Socket> => {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      return await connectWindowsPipe(
        pipeName,
        Math.min(150, remainingMs),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw windowsCancellationError(signal);
      lastError = error;
      await delayWithSignal(25, signal);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Windows stella-computer daemon connection failed");
};

type WindowsDaemonSpawn = typeof spawn;

export const spawnWindowsDaemonProcess = async (
  helperPath: string,
  pipeName: string,
  pidPath: string,
  signal = getComputerExecutionSignal(),
  spawnProcess: WindowsDaemonSpawn = spawn,
): Promise<ChildProcess> => {
  if (signal?.aborted) throw windowsCancellationError(signal);

  let child: ChildProcess;
  try {
    child = spawnProcess(
      helperPath,
      ["daemon", "--pipe-name", pipeName, "--pid-file", pidPath],
      {
        detached: false,
        stdio: "ignore",
        windowsHide: true,
        env: getComputerExecutionEnv(),
      },
    );
  } catch (error) {
    throw new Error(
      `Windows stella-computer daemon failed to spawn: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      signal?.removeEventListener("abort", onAbort);
    };
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `Windows stella-computer daemon failed to spawn: ${error.message}`,
        ),
      );
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcess(child.pid ?? null);
      reject(windowsCancellationError(signal));
    };

    child.once("spawn", onSpawn);
    // Deliberately retained after startup so a later ChildProcess error can never
    // become an unhandled EventEmitter error in the long-lived host.
    child.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  child.unref();
  return child;
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
  const child = await spawnWindowsDaemonProcess(helperPath, pipeName, pidPath);

  try {
    const deadline = Date.now() + windowsDaemonStartupBudgetMs;
    while (Date.now() < deadline) {
      const pid = readPidFile(pidPath);
      if (pid && pidIsRunning(pid)) {
        try {
          const socket = await connectWindowsPipe(pipeName, 100);
          socket.end();
          return true;
        } catch (error) {
          if (getComputerExecutionSignal()?.aborted) throw error;
          // Keep waiting until the named-pipe server accepts connections.
        }
      }
      await delayWithSignal(50, getComputerExecutionSignal());
    }
  } catch (error) {
    killProcess(child.pid ?? readPidFile(pidPath));
    fs.rmSync(pidPath, { force: true });
    throw error;
  }
  killProcess(child.pid ?? readPidFile(pidPath));
  fs.rmSync(pidPath, { force: true });
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

  const key = canonicalWindowsTargetKey(snapshot);
  const statePath = targetStatePathForKey(sessionId, key);
  const screenshotPath = targetScreenshotPathForKey(sessionId, key);
  const png = snapshot.screenshotPngBase64
    ? Buffer.from(snapshot.screenshotPngBase64, "base64")
    : null;

  writeJsonAtomic(statePath, snapshot);
  if (png) {
    fs.writeFileSync(screenshotPath, png);
  }

  const registry = readTargetRegistry(sessionId);
  registry.activeTargetKey = key;
  registry.targets[key] = {
    key,
    appName: snapshot.app.name,
    bundleIdentifier: snapshot.app.bundleIdentifier ?? null,
    pid: snapshot.app.pid,
    windowId: snapshot.windowId ?? null,
    statePath,
    screenshotPath,
    updatedAt: new Date().toISOString(),
  };
  for (const alias of aliases) {
    registry.aliases[normalizedAlias(alias)] = key;
    const legacyDirectory = path.dirname(
      targetStatePathForKey(sessionId, normalizedAlias(alias)),
    );
    if (legacyDirectory !== path.dirname(statePath)) {
      fs.rmSync(legacyDirectory, { recursive: true, force: true });
    }
  }
  writeTargetRegistry(sessionId, registry);
};

export const exchangeWindowsDaemonRequest = (
  socket: net.Socket,
  payload: string,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    onTimeoutOrAbort?: () => void;
  },
): Promise<string> =>
  new Promise((resolve, reject) => {
    const { signal } = options;
    socket.removeListener("error", ignoreWindowsPipeError);
    if (signal?.aborted) {
      options.onTimeoutOrAbort?.();
      socket.destroy();
      reject(windowsCancellationError(signal));
      return;
    }

    let settled = false;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => {
      settle(null, Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => {
      settle(
        new Error(
          `Windows stella-computer daemon connection failed: ${error.message}`,
        ),
      );
    };
    const onClose = () => {
      if (!settled) {
        settle(
          new Error(
            "Windows stella-computer daemon closed the request before returning a response.",
          ),
        );
      }
    };
    const onAbort = () => {
      options.onTimeoutOrAbort?.();
      settle(windowsCancellationError(signal));
    };
    const timer = setTimeout(() => {
      options.onTimeoutOrAbort?.();
      settle(
        new Error(
          `Windows stella-computer daemon timed out after ${options.timeoutMs}ms`,
        ),
      );
    }, options.timeoutMs);

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.on("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      socket.write(payload);
    } catch (error) {
      settle(
        error instanceof Error
          ? new Error(
              `Windows stella-computer daemon connection failed: ${error.message}`,
            )
          : new Error("Windows stella-computer daemon connection failed"),
      );
    }
  });

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
  const payload = encodeWindowsDaemonPayload(seq, request);

  const signal = getComputerExecutionSignal();
  const socket = await connectWindowsPipeWithRetry(pipeName, 1_000, signal);
  const responseText = await exchangeWindowsDaemonRequest(socket, payload, {
    timeoutMs: windowsHelperTimeoutMs,
    signal,
    onTimeoutOrAbort: () => stopWindowsDaemonUnlocked(sessionId),
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

  const registry = readTargetRegistry(sessionId);
  const candidates = Object.values(registry.targets).filter((candidate) =>
    fs.existsSync(candidate.statePath),
  );
  if (candidates.length === 1) {
    const snapshot = JSON.parse(
      fs.readFileSync(candidates[0]!.statePath, "utf8"),
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

export const getWindowsScreenshotPolicy = (
  args: string[],
): ScreenshotPolicy => {
  if (args.includes("--no-screenshot")) return "never";
  const configured = args.includes("--screenshot-policy");
  const value = getOptionValue(args, "--screenshot-policy") ?? "always";
  if (configured && !getOptionValue(args, "--screenshot-policy")) {
    throw new Error("--screenshot-policy requires a value.");
  }
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }
  throw new Error(`Invalid --screenshot-policy value: ${value}`);
};

export const getWindowsSelectionOptions = (args: string[]) => {
  const rawSelection = getOptionValue(args, "--selection") ?? "text";
  if (
    rawSelection !== "text" &&
    rawSelection !== "cursor-before" &&
    rawSelection !== "cursor-after"
  ) {
    throw new Error(`Invalid --selection value: ${rawSelection}`);
  }
  const selection: "text" | "cursor-before" | "cursor-after" = rawSelection;
  for (const flag of ["--prefix", "--suffix", "--selection"]) {
    if (args.includes(flag) && getOptionValue(args, flag) == null) {
      throw new Error(`${flag} requires a value.`);
    }
  }
  return {
    prefix: getOptionValue(args, "--prefix") ?? undefined,
    suffix: getOptionValue(args, "--suffix") ?? undefined,
    selection,
  };
};

const withObservationOptions = (
  request: WinHelperRequest,
  args: string[],
): WinHelperRequest => ({
  ...request,
  defer_observation: args.includes("--defer-observation"),
  screenshot_policy: "always",
});

export const encodeWindowsDaemonPayload = (
  seq: number,
  request: WinHelperRequest,
) => `${JSON.stringify({ seq, operation: request })}\n`;

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
    "--screenshot-policy",
    "--prefix",
    "--suffix",
    "--selection",
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
    "--defer-observation",
    "--disable-diff",
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
  const dims =
    snapshot.screenshot?.widthPx && snapshot.screenshot?.heightPx
      ? ` ${Math.round(snapshot.screenshot.widthPx)}x${Math.round(snapshot.screenshot.heightPx)}`
      : snapshot.windowBounds
        ? ` ${Math.round(snapshot.windowBounds.width)}x${Math.round(snapshot.windowBounds.height)}`
        : "";
  const sizeKb = bytes ? ` ${(bytes.byteLength / 1024).toFixed(0)}KB` : "";
  return `[stella-attach-image]${dims}${sizeKb} inline=image/png path=${JSON.stringify(path)}\n`;
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
  if (snapshot.revision != null) {
    lines.push(
      `State revision: ${snapshot.revision} (materialized ${snapshot.materializedRevision ?? snapshot.revision}, cache_hit=${snapshot.cacheHit === true ? "true" : "false"}, pending_actions=${snapshot.pendingActionCount ?? 0})`,
    );
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
  if (snapshot.appInstructions?.trim()) {
    writeComputerStdout(
      `<app_specific_instructions>\n${snapshot.appInstructions.trim()}\n</app_specific_instructions>\n`,
    );
  }
  writeComputerStdout(`${winSnapshotLines(snapshot).join("\n")}\n`);
  writeComputerStdout(formatScreenshotMarker(sessionId, app, snapshot));
};

const formatActionReceipt = (
  receipt: WinHelperResponse["receipt"] | undefined,
  fallbackDispatch: string | undefined,
) => {
  if (!receipt) return;
  writeComputerStdout(
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
    writeComputerStdout(
      `Action settle: ${source}; waited=${settle.waitedMs ?? 0}ms quiet=${settle.quietMs ?? 0}ms events=${settle.eventCount ?? 0} timed_out=${settle.timedOut === true ? "true" : "false"}${reason}\n`,
    );
  }
};

const emitJson = (value: unknown) => {
  writeComputerStdout(`${JSON.stringify(value, null, 2)}\n`);
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
  screenshotPolicy: ScreenshotPolicy = "always",
  disableDiff = false,
) => {
  const previous = readSnapshot(sessionId, app);
  const response = await runWindowsHelper(sessionId, {
    tool: "get_app_state",
    app,
    windowId,
    screenshot_policy: screenshotPolicy,
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
    if (disableDiff) {
      formatSnapshot(sessionId, app, response.snapshot);
      return;
    }
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
  if (!response.ok) {
    throw new Error(
      response.error || "Windows runtime did not complete the action.",
    );
  }
  if (request.defer_observation) {
    if (jsonMode) {
      emitJson({
        receipt: response.receipt ?? null,
        revision: response.revision ?? null,
        deferred: true,
      });
    } else {
      formatActionReceipt(response.receipt, request.dispatch);
      writeComputerStdout(
        `${request.tool} acknowledged; observation deferred to the next get-state.\n`,
      );
    }
    return;
  }
  if (!response.snapshot) {
    throw new Error("Windows runtime did not return an app snapshot.");
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
    writeComputerStdout(`${request.tool} completed.\n`);
    if (shouldUseDiffOnly(stateDiff)) {
      writeComputerStdout(formatStateDiffBlock(stateDiff));
      writeComputerStdout(
        formatScreenshotMarker(sessionId, app, response.snapshot),
      );
    } else {
      writeComputerStdout(formatStateDiffBlock(stateDiff));
      formatSnapshot(sessionId, app, response.snapshot);
    }
  }
};

const runWindowsStellaComputerForSession = async (
  argv: string[],
  jsonMode: boolean,
  sessionId: string,
) => {
  pruneWindowsSessions(sessionId);
  const command = argv[0]!;
  const args = argv.slice(1);

  if (command === "list-apps") {
    const response = await runWindowsHelper(sessionId, { tool: "list_apps" });
    if (!response.ok) {
      throw new Error(response.error || "Windows runtime failed to list apps.");
    }
    writeComputerStdout(
      response.text?.trimEnd() ||
        "No running top-level apps are visible to this Windows runtime.",
    );
    writeComputerStdout("\n");
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
      writeComputerStdout(
        response.text?.trimEnd() || formatWindowsText(response.windows),
      );
      writeComputerStdout("\n");
    }
    return 0;
  }

  if (command === "snapshot" || command === "get-state") {
    const target = appFromSnapshotArgs(args);
    await runSnapshot(
      sessionId,
      target.app,
      jsonMode,
      target.windowId,
      getWindowsScreenshotPolicy(target.args),
      target.args.includes("--disable-diff"),
    );
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
        writeComputerStdout(`${response.text.trimEnd()}\n`);
      } else {
        writeComputerStdout(`${formatWindowsText(response.windows)}\n`);
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
      withObservationOptions(
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
        target.args,
      ),
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
      withObservationOptions(
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
          screenshot_width: snapshot.screenshot?.widthPx ?? undefined,
          screenshot_height: snapshot.screenshot?.heightPx ?? undefined,
        },
        target.args,
      ),
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
      withObservationOptions(
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
          screenshot_width: snapshot.screenshot?.widthPx ?? undefined,
          screenshot_height: snapshot.screenshot?.heightPx ?? undefined,
        },
        target.args,
      ),
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
      withObservationOptions(
        {
          tool: "set_value",
          app: target.app,
          windowId: target.windowId ?? snapshot.windowId,
          element: lookupElement(snapshot, element),
          value: textParts.join(" "),
          windowBounds: snapshot.windowBounds ?? null,
        },
        target.args,
      ),
      jsonMode,
    );
    return 0;
  }

  if (command === "select-text") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, ...textParts] = positionals;
    const text = textParts.join(" ");
    if (!element || !text) {
      throw new Error("select-text requires an element index and exact text.");
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const selection = getWindowsSelectionOptions(target.args);
    await runAction(
      sessionId,
      target.app,
      withObservationOptions(
        {
          tool: "select_text",
          app: target.app,
          windowId: target.windowId ?? snapshot.windowId,
          element: lookupElement(snapshot, element),
          text,
          prefix: selection.prefix,
          suffix: selection.suffix,
          selection: selection.selection,
          windowBounds: snapshot.windowBounds ?? null,
        },
        target.args,
      ),
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
      withObservationOptions(
        {
          tool: "perform_secondary_action",
          app: target.app,
          windowId: target.windowId ?? snapshot.windowId,
          element: lookupElement(snapshot, element),
          action,
          windowBounds: snapshot.windowBounds ?? null,
        },
        target.args,
      ),
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
      withObservationOptions(
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
        target.args,
      ),
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
      withObservationOptions(
        {
          tool: "type_text",
          app: target.app,
          windowId: target.windowId ?? snapshot.windowId,
          text,
          dispatch: getDispatchOption(target.args),
        },
        target.args,
      ),
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
      withObservationOptions(
        {
          tool: "press_key",
          app: target.app,
          windowId: target.windowId ?? snapshot.windowId,
          key,
          dispatch: getDispatchOption(target.args),
        },
        target.args,
      ),
      jsonMode,
    );
    return 0;
  }

  if (command === "doctor") {
    const response = await runWindowsHelper(sessionId, { tool: "doctor" });
    if (!response.ok) {
      throw new Error(response.error || "Windows runtime doctor failed.");
    }
    writeComputerStdout(
      [
        response.text?.trimEnd() ||
          "Windows runtime: stella-computer-helper.exe",
        "Action routes: UI Automation patterns first, then Win32 window messages for background-safe fallback.",
        `App launch opt-in: ${isTruthyEnv(getComputerExecutionEnv().STELLA_COMPUTER_WINDOWS_ALLOW_APP_LAUNCH) ? "enabled" : "disabled"}`,
        `Focus actions opt-in: ${isTruthyEnv(getComputerExecutionEnv().STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS) ? "enabled" : "disabled"}`,
        `UIA text fallback opt-in: ${isTruthyEnv(getComputerExecutionEnv().STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK) ? "enabled" : "disabled"}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage}`);
};

export const runWindowsStellaComputer = async (
  argv: string[],
  jsonMode: boolean,
  sessionOverride?: string | null,
) => {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    writeComputerStdout(usage);
    return 0;
  }
  const sessionId = getSessionId(sessionOverride);
  return await withWindowsComputerSessionLock(sessionId, () =>
    runWindowsStellaComputerForSession(argv, jsonMode, sessionId),
  );
};
