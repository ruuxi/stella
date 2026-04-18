#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveStatePath } from "./shared.js";
import { resolveNativeHelperPath, runNativeHelper } from "./native-helper.js";
import { screenshotPixelToScreenPoint } from "./screenshot-coordinates.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Screenshot = {
  mimeType: string;
  data: string;
  path?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  byteCount?: number | null;
};

type SnapshotNode = {
  index?: number | null;
  ref?: string | null;
  role: string;
  subrole?: string | null;
  title?: string | null;
  description?: string | null;
  value?: string | null;
  valueType?: string | null;
  settable?: boolean | null;
  details?: string | null;
  help?: string | null;
  identifier?: string | null;
  url?: string | null;
  enabled?: boolean | null;
  focused?: boolean | null;
  selected?: boolean | null;
  frame?: Rect | null;
  actions: string[];
  children: SnapshotNode[];
};

type OverlayEntry = {
  frame?: Rect | null;
};

type SnapshotDocument = {
  ok: boolean;
  appName: string;
  bundleId?: string | null;
  pid: number;
  windowTitle?: string | null;
  windowFrame?: Rect | null;
  windowId?: number | null;
  nodeCount: number;
  refCount: number;
  refs?: Record<string, OverlayEntry> | null;
  indices?: Record<string, OverlayEntry> | null;
  warnings: string[];
  screenshotPath?: string | null;
  screenshot?: Screenshot | null;
  appInstructions?: string | null;
  nodes: SnapshotNode[];
  capturedAt?: string | null;
  maxDepth?: number | null;
  maxNodes?: number | null;
  allWindows?: boolean | null;
};

type ActionPayload = {
  ok: boolean;
  action: string;
  ref?: string | null;
  message: string;
  matchedRef?: string | null;
  usedAction?: string | null;
  warnings: string[];
  screenshotPath?: string | null;
  screenshot?: Screenshot | null;
  appInstructions?: string | null;
  snapshotText?: string | null;
};

type ListedAppPayload = {
  name: string;
  bundleId?: string | null;
  pid: number;
  activationPolicy: string;
  isActive: boolean;
};

type ListAppsPayload = {
  ok: boolean;
  apps: ListedAppPayload[];
  warnings: string[];
};

type ErrorPayload = {
  ok: boolean;
  error: string;
  warnings?: string[];
  screenshotPath?: string | null;
  screenshot?: Screenshot | null;
};

type SessionPaths = {
  sessionId: string;
  sessionDir: string;
  statePath: string;
  screenshotPath: string;
};

type OverlayCommandPayload = {
  seq: number;
  action: "show" | "hide" | "close";
  frame?: Rect;
  viewportFrame?: Rect;
  cursorPoint?: { x: number; y: number };
  interactionKind?: string | null;
  // Preferred exact target window ID plus fallback identity hints. Codex's
  // overlay API takes `aboveWindowID` directly; we mirror that when Stella
  // has a resolved `windowId`, and only fall back to pid/title matching when
  // the live window ID has changed.
  targetWindowId?: number | null;
  targetPid?: number;
  targetBundleId?: string | null;
  targetWindowTitle?: string | null;
};

const stateDir = path.join(resolveStatePath(), "stella-computer");
const sessionsDir = path.join(stateDir, "sessions");
const locksDir = path.join(stateDir, "locks");
const defaultSessionId = "manual";
const defaultSessionStateExample = path.join(
  stateDir,
  "sessions",
  "<session>",
  "last-snapshot.json",
);
const defaultLockTimeoutMs = 30_000;
const staleLockTimeoutMs = 90_000;
const lockPollIntervalMs = 125;

const usage = `stella-computer - control macOS apps through Accessibility

Usage:
  stella-computer list-apps
  stella-computer [--session ID] snapshot [--app NAME|--bundle-id ID|--pid PID] [--all-windows] [--screenshot [PATH]|--no-screenshot] [--no-inline-screenshot] [--max-depth N] [--max-nodes N]
  stella-computer [--session ID] get-state [--app NAME|--bundle-id ID|--pid PID] [--all-windows] [--screenshot [PATH]|--no-screenshot] [--no-inline-screenshot] [--max-depth N] [--max-nodes N]
  stella-computer [--session ID] click <element> [--coordinate-fallback] [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise] [--no-overlay]
  stella-computer [--session ID] fill <element> <text> [--no-screenshot] [--no-inline-screenshot] [--no-raise] [--no-overlay]
  stella-computer [--session ID] focus <element> [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] secondary-action <element> <action> [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] scroll <element> <up|down|left|right> [--pages N] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] drag <from_x> <from_y> <to_x> <to_y> [--allow-hid] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] drag-element <source-element> (<dest-element> | <to_x> <to_y> | --to-ref REF | --to-x N --to-y N) [--type file|url|text] [--operation copy|link|move|every] [--allow-hid] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] click-point <x> <y> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]
  stella-computer [--session ID] click-screenshot <x_px> <y_px> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]
  stella-computer [--session ID] drag-screenshot <from_x_px> <from_y_px> <to_x_px> <to_y_px> [--allow-hid] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] type <text> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]
  stella-computer [--session ID] press <key> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]

Notes:
  - snapshot writes element state to ${defaultSessionStateExample}
  - get-state is an alias for snapshot
  - click/fill/focus/secondary-action/scroll/drag reuse the last snapshot state unless --state is provided
  - snapshot captures a window screenshot by default; pass --no-screenshot to skip it
  - --all-windows enumerates every accessibility window the app advertises (default: focused only)
  - successful actions refresh the numbered snapshot state and the attached screenshot automatically
  - screenshots are auto-attached inline (base64 PNG); pass --no-inline-screenshot to keep only the file path
  - the agent runtime detects "[stella-attach-image]" markers in output and attaches the image as vision input on the next turn
  - Stella isolates default state/screenshot files by session; agent runs set that session automatically
  - HID fallbacks require --allow-hid (or STELLA_COMPUTER_ALLOW_HID=1) because they can interfere with active user input
  - element actions accept the numbered IDs shown in snapshot output (and still accept legacy @d refs); macOS Accessibility is tried first so Stella avoids taking over the physical cursor
  - click-screenshot / drag-screenshot interpret coordinates in attached screenshot pixels, then map them back into screen space using the saved window frame
  - --no-raise (or STELLA_COMPUTER_NO_RAISE=1) avoids bringing the target app frontmost during click/type/press
  - actions keep a session overlay alive between targets so the software cursor visibly moves from action to action; pass --no-overlay (or STELLA_COMPUTER_NO_OVERLAY=1) to skip it
  - STELLA_COMPUTER_ALWAYS_SIMULATE_INPUT=1 forces CGEvent synthesis for click/type/press (CLICK alias kept for back-compat)
  - STELLA_COMPUTER_APP_INSTRUCTIONS_DIR=<dir> adds per-bundle markdown manuals (e.g. com.example.app.md)
  - Forbidden bundles: ${"set STELLA_COMPUTER_FORBIDDEN_BUNDLES=a,b,c to extend; the built-in deny list covers Stella, Keychain, password managers, System Settings"}
  - Forbidden URLs: ${"set STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS=foo,bar to extend; the built-in list covers banking + auth surfaces"}
`;

const stripFlag = (args: string[], flag: string) => {
  const nextArgs: string[] = [];
  let found = false;
  for (const arg of args) {
    if (arg === flag) {
      found = true;
      continue;
    }
    nextArgs.push(arg);
  }
  return { found, args: nextArgs };
};

const stripOptionValue = (args: string[], flag: string) => {
  const nextArgs: string[] = [];
  let value: string | null = null;
  let missingValue = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === flag) {
      const nextValue = args[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        missingValue = true;
      } else {
        value = nextValue;
        index += 1;
      }
      continue;
    }
    if (current.startsWith(`${flag}=`)) {
      value = current.slice(flag.length + 1);
      continue;
    }
    nextArgs.push(current);
  }

  return { value, args: nextArgs, missingValue };
};

const getOptionValue = (args: string[], flag: string) => {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === flag) {
      return index + 1 < args.length ? args[index + 1] : null;
    }
    if (current.startsWith(`${flag}=`)) {
      return current.slice(flag.length + 1);
    }
  }
  return null;
};

const hasOption = (args: string[], flag: string) =>
  args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));

const splitArgsIntoPositionalsAndOptions = (args: string[]) => {
  const positionals: string[] = [];
  const options: string[] = [];
  let index = 0;

  while (index < args.length) {
    const current = args[index];
    if (current.startsWith("--")) {
      options.push(current);
      if (
        !current.includes("=") &&
        index + 1 < args.length &&
        !args[index + 1].startsWith("--")
      ) {
        options.push(args[index + 1]);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    positionals.push(current);
    index += 1;
  }

  return { positionals, options };
};

const deriveScreenshotPath = (statePath: string) => {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, `${parsed.name}.png`);
};

const overlayCommandPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "overlay-command.json");

const overlayPidPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "overlay.pid");

const resolveSessionPaths = (sessionOverride?: string | null): SessionPaths => {
  const sessionId =
    sanitizeStellaComputerSessionId(sessionOverride) ??
    sanitizeStellaComputerSessionId(process.env.STELLA_COMPUTER_SESSION) ??
    defaultSessionId;
  const sessionDir = path.join(sessionsDir, sessionId);
  const statePath = path.join(sessionDir, "last-snapshot.json");
  return {
    sessionId,
    sessionDir,
    statePath,
    screenshotPath: deriveScreenshotPath(statePath),
  };
};

const withStatePath = (args: string[], sessionPaths: SessionPaths) => {
  if (hasOption(args, "--state")) {
    return args;
  }
  return ["--state", sessionPaths.statePath, ...args];
};

const ensureStateDirectory = (sessionPaths: SessionPaths) => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(sessionPaths.sessionDir, { recursive: true });
};

const pidIsRunning = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPidFile = (pidPath: string) => {
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
};

const delayMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureOverlayDaemon = async (sessionPaths: SessionPaths) => {
  const pidPath = overlayPidPath(sessionPaths);
  const existingPid = readPidFile(pidPath);
  if (existingPid && pidIsRunning(existingPid)) {
    return true;
  }
  fs.rmSync(pidPath, { force: true });
  fs.rmSync(overlayCommandPath(sessionPaths), { force: true });

  const helperPath = resolveNativeHelperPath("desktop_overlay");
  if (!helperPath) {
    return false;
  }

  const child = spawn(
    helperPath,
    [
      "--command-file",
      overlayCommandPath(sessionPaths),
      "--pid-file",
      pidPath,
    ],
    {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delayMs(25);
    const pid = readPidFile(pidPath);
    if (pid && pidIsRunning(pid)) {
      return true;
    }
  }
  return false;
};

const writeOverlayCommand = (sessionPaths: SessionPaths, payload: OverlayCommandPayload) => {
  const finalPath = overlayCommandPath(sessionPaths);
  const tempPath = `${finalPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload));
  fs.renameSync(tempPath, finalPath);
};

// The daemon writes its real per-move duration into
// `overlay-busy-until.json`. Wrappers should always read that file;
// they never compute their own duration. We keep this constant only as
// the *upper bound* spawn budget (spawn = first show, no inbound move
// yet) so we don't wedge waiting for a busy clock the daemon may not
// have written yet.
const overlaySpawnBudgetMs = 1200;

const overlayBusyUntilPath = (sessionPaths: SessionPaths) =>
  path.join(sessionPaths.sessionDir, "overlay-busy-until.json");

type OverlayBusyState = {
  busyUntilMs: number;
  // Wall-clock ms at which the daemon says the cursor satisfies Codex's
  // `nextInteractionTiming.closeEnough` predicate. For click-like moves
  // this is the moment the wrapper is allowed to dispatch the underlying
  // HID action so it lands in sync with the visible press pulse. For
  // non-click moves it equals `busyUntilMs`. May be 0/undefined if read
  // from a daemon binary that predates the field.
  actionReadyAtMs: number;
};

const readOverlayBusyState = (sessionPaths: SessionPaths): OverlayBusyState => {
  try {
    const raw = fs.readFileSync(overlayBusyUntilPath(sessionPaths), "utf8");
    const parsed = JSON.parse(raw) as {
      busyUntilMs?: number;
      actionReadyAtMs?: number;
    };
    const busyUntilMs = Number.isFinite(parsed.busyUntilMs)
      ? Number(parsed.busyUntilMs)
      : 0;
    const actionReadyAtMs = Number.isFinite(parsed.actionReadyAtMs)
      ? Number(parsed.actionReadyAtMs)
      : busyUntilMs;
    return { busyUntilMs, actionReadyAtMs };
  } catch {
    return { busyUntilMs: 0, actionReadyAtMs: 0 };
  }
};

const readOverlayBusyUntil = (sessionPaths: SessionPaths): number =>
  readOverlayBusyState(sessionPaths).busyUntilMs;

const writeOverlayBusyUntil = (sessionPaths: SessionPaths, busyUntilMs: number) => {
  const finalPath = overlayBusyUntilPath(sessionPaths);
  const tempPath = `${finalPath}.tmp`;
  // Pre-seed both fields so a click-like helper that races us doesn't
  // see only `busyUntilMs` and assume actionReady = busyUntil. The
  // daemon will overwrite both in a few ms with its real values.
  fs.writeFileSync(
    tempPath,
    JSON.stringify({ busyUntilMs, actionReadyAtMs: busyUntilMs }),
  );
  fs.renameSync(tempPath, finalPath);
};

const waitForOverlayIdle = async (sessionPaths: SessionPaths) => {
  // Re-read the busy file repeatedly: the daemon may extend the budget
  // mid-move (e.g. queue a follow-up action) while we're sleeping.
  // Without re-reading, we'd return early and race the next show.
  for (;;) {
    const busyUntilMs = readOverlayBusyUntil(sessionPaths);
    const remainingMs = busyUntilMs - Date.now();
    if (remainingMs <= 0) return;
    await delayMs(Math.min(remainingMs, 60));
  }
};

// Wait until the daemon publishes that the cursor has reached its
// `closeEnough` threshold to the click target. This is what gates the
// real HID action dispatch so the click visually lands in sync with
// the press pulse instead of after the full move + pulse animation.
//
// Re-reads the file each loop iteration because the daemon may move
// `actionReadyAtMs` *earlier* mid-flight if the cursor crosses the
// distance threshold before the predicted progress threshold (the file
// gets re-published with `actionReadyInSeconds: 0` the moment that
// happens in `tick()`).
const waitForOverlayActionReady = async (sessionPaths: SessionPaths) => {
  for (;;) {
    const { actionReadyAtMs } = readOverlayBusyState(sessionPaths);
    const remainingMs = actionReadyAtMs - Date.now();
    if (remainingMs <= 0) return;
    await delayMs(Math.min(remainingMs, 30));
  }
};

// After we write a `show` command, the daemon needs a few ms to pick
// it up off disk, build the path, and publish the real per-move
// duration into the busy file. We pre-seed a short upper-bound budget
// before sending the command, then wait here for the daemon to either:
//   (a) overwrite the file with its own (typically longer) duration,
//   (b) leave the pre-seeded value in place (e.g. spawn-only frame),
// then return. This keeps the wrapper from racing the daemon.
const waitForDaemonBusyClock = async (
  sessionPaths: SessionPaths,
  showSentAtMs: number,
) => {
  const deadline = showSentAtMs + 250;
  for (;;) {
    const busyUntilMs = readOverlayBusyUntil(sessionPaths);
    if (busyUntilMs > showSentAtMs + overlaySpawnBudgetMs - 50) return;
    if (Date.now() > deadline) return;
    await delayMs(15);
  }
};

const isValidRect = (rect: Rect | null | undefined): rect is Rect =>
  !!rect &&
  Number.isFinite(rect.x) &&
  Number.isFinite(rect.y) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > 0 &&
  rect.height > 0;

type ResolvedOverlayTarget = {
  frame: Rect;
  viewportFrame: Rect;
  cursorPoint: { x: number; y: number };
  interactionKind?: string | null;
  targetWindowId?: number | null;
  targetPid?: number;
  targetBundleId?: string | null;
  targetWindowTitle?: string | null;
};

const resolveOverlayTarget = (
  command: string,
  args: string[],
  snapshot: SnapshotDocument | null,
): ResolvedOverlayTarget | null => {
  const { positionals } = splitArgsIntoPositionalsAndOptions(args);
  const centerOf = (frame: Rect) => ({
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  });

  if (!snapshot || !isValidRect(snapshot.windowFrame)) {
    return null;
  }

  const identity = {
    interactionKind: command,
    targetWindowId: snapshot.windowId ?? null,
    targetPid: snapshot.pid,
    targetBundleId: snapshot.bundleId ?? null,
    targetWindowTitle: snapshot.windowTitle ?? null,
  } as const;

  if (command === "click-point" && positionals.length >= 2) {
    const x = Number(positionals[0]);
    const y = Number(positionals[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const frame = { x: x - 24, y: y - 24, width: 48, height: 48 };
      return {
        frame,
        viewportFrame: snapshot.windowFrame,
        cursorPoint: { x, y },
        ...identity,
      };
    }
  }

  if (positionals.length === 0) {
    return null;
  }

  const targetId = positionals[0];
  const entry =
    snapshot.indices?.[targetId] ??
    snapshot.refs?.[targetId] ??
    null;
  if (!entry?.frame) {
    return null;
  }
  return {
    frame: entry.frame,
    viewportFrame: snapshot.windowFrame,
    cursorPoint: centerOf(entry.frame),
    ...identity,
  };
};

const commandUsesPersistentOverlay = (command: string) =>
  command === "click" ||
  command === "fill" ||
  command === "focus" ||
  command === "secondary-action" ||
  command === "perform-secondary-action" ||
  command === "scroll" ||
  command === "click-point";

// Mirror of the daemon-side `isClickLikeInteraction` predicate. The
// wrapper waits on `actionReadyAtMs` (early release at closeEnough) for
// these commands; everything else waits on full move completion before
// dispatching the helper, since there's no visible press to sync to.
const commandIsClickLike = (command: string) =>
  command === "click" ||
  command === "click-point" ||
  command === "secondary-action" ||
  command === "perform-secondary-action";

const withNoOverlayFlag = (args: string[]) =>
  hasOption(args, "--no-overlay") ? args : [...args, "--no-overlay"];

const maybePrimePersistentOverlay = async (
  command: string,
  helperArgs: string[],
  sessionPaths: SessionPaths,
) => {
  if (
    !commandUsesPersistentOverlay(command) ||
    hasOption(helperArgs.slice(1), "--no-overlay") ||
    process.env.STELLA_COMPUTER_NO_OVERLAY === "1"
  ) {
    return {
      helperArgs,
      daemonActive: false,
    };
  }

  const statePath = getOptionValue(helperArgs.slice(1), "--state") ?? sessionPaths.statePath;
  const target = resolveOverlayTarget(command, helperArgs.slice(1), readSnapshotDocument(statePath));
  if (!target) {
    return {
      helperArgs: withNoOverlayFlag(helperArgs),
      daemonActive: false,
    };
  }

  const daemonReady = await ensureOverlayDaemon(sessionPaths);
  if (!daemonReady) {
    return {
      helperArgs,
      daemonActive: false,
    };
  }

  // Pace consecutive actions: don't fire a new arc (or its underlying
  // mouse action) until the previous arc has finished animating. The
  // daemon owns the busy clock — it knows the real per-move duration —
  // so we just read whatever it wrote.
  await waitForOverlayIdle(sessionPaths);

  const showSentAt = Date.now();
  writeOverlayCommand(sessionPaths, {
    seq: showSentAt,
    action: "show",
    frame: target.frame,
    viewportFrame: target.viewportFrame,
    cursorPoint: target.cursorPoint,
    interactionKind: target.interactionKind,
    targetWindowId: target.targetWindowId,
    targetPid: target.targetPid,
    targetBundleId: target.targetBundleId,
    targetWindowTitle: target.targetWindowTitle,
  });
  // Pre-seed a short upper-bound budget so the *next* invocation that
  // races us doesn't see an empty file and skip waiting. The daemon
  // will overwrite this with the real duration in a few ms.
  writeOverlayBusyUntil(sessionPaths, showSentAt + overlaySpawnBudgetMs);
  // Now wait for the daemon to either (a) actually start the move and
  // publish a real duration, or (b) finish a quick spawn-only frame.
  // Either way, by the time we return, we're either still in our
  // pre-seeded budget OR the daemon has taken over the budget — so the
  // wrapper-side action body below races against an accurate clock.
  await waitForDaemonBusyClock(sessionPaths, showSentAt);

  return {
    helperArgs: withNoOverlayFlag(helperArgs),
    daemonActive: true,
  };
};

const ensureSnapshotArgs = (args: string[], sessionPaths: SessionPaths) => {
  const nextArgs = [...args];
  const statePath = getOptionValue(nextArgs, "--state") ?? sessionPaths.statePath;
  if (!hasOption(nextArgs, "--state")) {
    nextArgs.unshift(statePath);
    nextArgs.unshift("--state");
  }

  if (!hasOption(nextArgs, "--screenshot") && !nextArgs.includes("--no-screenshot")) {
    nextArgs.unshift(deriveScreenshotPath(statePath));
    nextArgs.unshift("--screenshot");
  }

  const screenshotIndex = nextArgs.findIndex((arg) => arg === "--screenshot");
  if (screenshotIndex >= 0) {
    const nextValue = nextArgs[screenshotIndex + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      nextArgs.splice(screenshotIndex, 1, "--screenshot", deriveScreenshotPath(statePath));
    }
  }

  return nextArgs;
};

const truncate = (value: string | null | undefined, limit = 80) => {
  if (!value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
};

const ACTIONS_TO_HIDE = new Set([
  "AXPress",
  "AXShowMenu",
  "AXScrollToVisible",
  "AXIncrement",
  "AXDecrement",
]);

const ROLES_WITH_VISIBLE_SETTABLE_STATE = new Set([
  "AXCell",
  "AXCheckBox",
  "AXComboBox",
  "AXPopUpButton",
  "AXRadioButton",
  "AXSearchField",
  "AXSecureTextField",
  "AXSlider",
  "AXSplitter",
  "AXSwitch",
  "AXTextArea",
  "AXTextField",
]);

const formatUrlLike = (value: string) => value.replace(/^https?:\/\//, "");

const humanActionName = (action: string) => {
  const trimmed = action.startsWith("AX") ? action.slice(2) : action;
  return trimmed.replace(/([a-z])([A-Z])/g, "$1 $2");
};

const humanRole = (node: Pick<SnapshotNode, "role" | "subrole">): string => {
  switch (node.role) {
    case "AXWindow":
      return node.subrole === "AXStandardWindow" ? "standard window" : "window";
    case "AXWebArea":
      return "HTML content";
    case "AXGroup":
    case "AXGenericElement":
    case "AXUnknown":
    case "AXSplitGroup":
      return "container";
    case "AXStaticText":
      return "text";
    case "AXCheckBox":
      return node.subrole === "AXSwitch" ? "switch" : "checkbox";
    case "AXList":
      return "list box";
    default: {
      const trimmed = node.role.startsWith("AX") ? node.role.slice(2) : node.role;
      return trimmed
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();
    }
  }
};

const secondaryActions = (actions: string[]) =>
  actions
    .filter((action) => !ACTIONS_TO_HIDE.has(action))
    .map((action) => humanActionName(action));

const displayValue = (node: SnapshotNode) => {
  if (!node.value) return null;
  if (node.subrole === "AXSwitch" && inferredValueType(node) === "boolean") {
    if (node.value === "1") return "on";
    if (node.value === "0") return "off";
  }
  return node.value;
};

const shouldSurfaceSettable = (node: SnapshotNode) =>
  !!node.settable &&
  (
    ROLES_WITH_VISIBLE_SETTABLE_STATE.has(node.role) ||
    node.subrole === "AXSwitch" ||
    !!node.value
  );

const inferredValueType = (node: SnapshotNode) => {
  if (node.role === "AXSlider") return "float";
  if (node.subrole === "AXSwitch") return "boolean";
  if (node.valueType && node.valueType !== "error") return node.valueType;
  if (!shouldSurfaceSettable(node)) return null;
  return "string";
};

const choosePrimaryLabel = (node: SnapshotNode) => {
  if (node.title) return node.title;
  if (node.role === "AXStaticText" && node.value) return node.value;
  if (
    (node.role === "AXButton" ||
      node.role === "AXComboBox" ||
      node.role === "AXMenuItem" ||
      node.role === "AXRow" ||
      node.role === "AXWindow" ||
      node.role === "AXGroup" ||
      node.role === "AXGenericElement" ||
      node.role === "AXHeading" ||
      node.role === "AXList") &&
    node.description
  ) {
    return node.description;
  }
  if (!node.title && !node.description && node.value) return node.value;
  return null;
};

const annotationSegment = (node: SnapshotNode) => {
  const flags: string[] = [];
  if (node.enabled === false) flags.push("disabled");
  if (node.selected) flags.push("selected");
  if (node.focused) flags.push("focused");
  if (shouldSurfaceSettable(node)) {
    flags.push("settable");
    const valueType = inferredValueType(node);
    if (valueType) flags.push(valueType);
  }
  return flags.length > 0 ? ` (${flags.join(", ")})` : "";
};

const formatNodeLinesCodex = (node: SnapshotNode, depth = 0): string[] => {
  const indent = "\t".repeat(depth);
  const id =
    typeof node.index === "number" && Number.isFinite(node.index)
      ? String(node.index)
      : (node.ref ?? "_");
  const role = humanRole(node);
  const primaryLabel = choosePrimaryLabel(node);
  const extras: string[] = [];

  if (
    node.description &&
    node.description !== primaryLabel &&
    (node.role === "AXLink" || node.role === "AXCheckBox" || node.subrole === "AXSwitch")
  ) {
    extras.push(`Description: ${truncate(node.description, 120)}`);
  }

  const renderedValue = displayValue(node);
  if (renderedValue && renderedValue !== primaryLabel) {
    extras.push(`Value: ${truncate(renderedValue, 120)}`);
  }

  if (node.details && node.details !== primaryLabel && node.details !== renderedValue) {
    extras.push(`Details: ${truncate(node.details, 120)}`);
  }

  if (node.help && node.help !== primaryLabel) {
    extras.push(`Help: ${truncate(node.help, 120)}`);
  }

  if (
    node.identifier &&
    node.identifier !== primaryLabel &&
    node.identifier !== node.description &&
    node.identifier !== node.value
  ) {
    extras.push(`ID: ${truncate(node.identifier, 120)}`);
  }

  if (node.url) {
    const renderedUrl = truncate(formatUrlLike(node.url), 100);
    if (node.role === "AXLink" && !renderedValue) {
      extras.push(`Value: ${renderedUrl}`);
    } else {
      extras.push(`URL: ${renderedUrl}`);
    }
  }

  const actions = secondaryActions(node.actions ?? []);
  if (actions.length > 0) {
    extras.push(`Secondary Actions: ${actions.join(", ")}`);
  }

  let line = `${indent}${id} ${role}${annotationSegment(node)}`;
  if (primaryLabel) {
    line += ` ${truncate(primaryLabel, 120)}`;
  }
  if (extras.length > 0) {
    line += `, ${extras.join(", ")}`;
  }
  return [line, ...node.children.flatMap((child) => formatNodeLinesCodex(child, depth + 1))];
};

const findFocusedElement = (
  nodes: SnapshotNode[],
): { index: number | string; role: string } | null => {
  for (const node of nodes) {
    if (node.focused) {
      return {
        index:
          typeof node.index === "number" && Number.isFinite(node.index)
            ? node.index
            : (node.ref ?? "_"),
        role: humanRole(node),
      };
    }
    const nested = findFocusedElement(node.children);
    if (nested) return nested;
  }
  return null;
};

const printWarnings = (warnings: string[] | undefined) => {
  for (const warning of warnings ?? []) {
    process.stdout.write(`[warning] ${warning}\n`);
  }
};

const parseJson = <T>(text: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse desktop automation response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

// Emit a "[stella-attach-image]" marker line that the runtime layer can
// detect when reading shell output to auto-attach the image as a vision
// content block to the next assistant turn. The line is also human-readable
// so it does no harm if the host doesn't auto-detect it. We include the
// width/height so callers can pre-budget vision token cost without a follow-
// up `Read` step.
const formatScreenshotMarker = (screenshot?: Screenshot | null, fallbackPath?: string | null) => {
  const path = screenshot?.path ?? fallbackPath ?? null;
  if (!path && !screenshot?.data) return "";
  const dims = screenshot?.widthPx && screenshot?.heightPx
    ? ` ${screenshot.widthPx}x${screenshot.heightPx}`
    : "";
  const sizeKb = screenshot?.byteCount
    ? ` ${(screenshot.byteCount / 1024).toFixed(0)}KB`
    : "";
  const inline = screenshot?.data ? " inline=image/png" : "";
  if (path) {
    return `[stella-attach-image]${dims}${sizeKb}${inline} ${path}\n`;
  }
  return `[stella-attach-image]${dims}${sizeKb}${inline}\n`;
};

const formatAppInstructions = (instructions?: string | null) => {
  if (!instructions) return "";
  const trimmed = instructions.trim();
  if (!trimmed) return "";
  return `<app_specific_instructions>\n${trimmed}\n</app_specific_instructions>\n`;
};

const formatBundleSpecificStateNote = (snapshot: SnapshotDocument) => {
  if (snapshot.bundleId !== "com.spotify.client") {
    return "";
  }
  return (
    'Note: In order to be usable, Spotify app links must be rewritten as regular links ' +
    '(e.g. use open.spotify.com instead of xpui.app.spotify.com). Only use Spotify links ' +
    'that are written verbatim in the UI above. Note that IDs are only valid with their ' +
    'associated type (e.g. you cannot change an "album" URL to a "track" URL).'
  );
};

const formatAppStateBlock = (snapshot: SnapshotDocument) => {
  process.stdout.write("<app_state>\n");
  const appLabel = snapshot.bundleId
    ? `App=${snapshot.bundleId} (pid ${snapshot.pid})`
    : `App=${snapshot.appName} (pid ${snapshot.pid})`;
  process.stdout.write(`${appLabel}\n`);
  if (snapshot.windowTitle) {
    process.stdout.write(`Window: "${snapshot.windowTitle}", App: ${snapshot.appName}.\n`);
  }
  for (const node of snapshot.nodes) {
    process.stdout.write(`${formatNodeLinesCodex(node).join("\n")}\n`);
  }
  const focused = findFocusedElement(snapshot.nodes);
  if (focused) {
    process.stdout.write(`\nThe focused UI element is ${focused.index} ${focused.role}.\n`);
  }
  const bundleNote = formatBundleSpecificStateNote(snapshot);
  if (bundleNote) {
    process.stdout.write(`\n${bundleNote}\n`);
  }
  process.stdout.write("</app_state>\n");
};

const formatSnapshot = (snapshot: SnapshotDocument) => {
  const instructions = formatAppInstructions(snapshot.appInstructions);
  if (instructions) {
    process.stdout.write(instructions);
  }
  formatAppStateBlock(snapshot);

  process.stdout.write(formatScreenshotMarker(snapshot.screenshot, snapshot.screenshotPath));
  printWarnings(snapshot.warnings);
};

const formatAction = (payload: ActionPayload, snapshot: SnapshotDocument | null) => {
  process.stdout.write(
    payload.message.replace(/\bAX[A-Za-z]+\b/g, (action) => humanActionName(action)),
  );
  process.stdout.write("\n");
  if (snapshot) {
    formatAppStateBlock(snapshot);
  }
  process.stdout.write(formatScreenshotMarker(payload.screenshot, payload.screenshotPath));
  printWarnings(payload.warnings);
};

const formatListApps = (payload: ListAppsPayload) => {
  process.stdout.write(`[apps] ${payload.apps.length}\n`);
  for (const app of payload.apps) {
    const parts = [`pid ${app.pid}`, app.activationPolicy];
    if (app.bundleId) {
      parts.push(app.bundleId);
    }
    if (app.isActive) {
      parts.push("active");
    }
    process.stdout.write(`- ${app.name} [${parts.join("] [")}]\n`);
  }
  printWarnings(payload.warnings);
};

const formatError = (payload: ErrorPayload) => {
  process.stderr.write(payload.error);
  process.stderr.write("\n");
  // Mirror the action/snapshot screenshot-marker contract on the error path
  // so failures still expose the diagnostic capture without requiring an
  // extra Read step.
  const marker = formatScreenshotMarker(payload.screenshot, payload.screenshotPath);
  if (marker) process.stderr.write(marker);
  for (const warning of payload.warnings ?? []) {
    process.stderr.write(`[warning] ${warning}\n`);
  }
};

const emitError = (payload: ErrorPayload, jsonMode: boolean) => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    formatError(payload);
  }
  process.exit(1);
};

const isTruthyEnv = (value: string | undefined) =>
  typeof value === "string" && /^(1|true|yes)$/i.test(value.trim());

const hidAllowed = (args: string[]) =>
  hasOption(args, "--allow-hid") || isTruthyEnv(process.env.STELLA_COMPUTER_ALLOW_HID);

const normalizeLockKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);

const fallbackStateLockKey = (statePath: string) => {
  const relative = path.relative(stateDir, path.resolve(statePath));
  return `state-${normalizeLockKey(relative || path.basename(statePath)) || "default"}`;
};

const readSnapshotDocument = (statePath: string): SnapshotDocument | null => {
  try {
    return parseJson<SnapshotDocument>(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
};

const translateScreenshotCoordinateCommand = (
  command: string,
  args: string[],
  sessionPaths: SessionPaths,
) => {
  if (command !== "click-screenshot" && command !== "drag-screenshot") {
    return { command, args };
  }

  const { positionals, options } = splitArgsIntoPositionalsAndOptions(args);
  const statePath = getOptionValue(options, "--state") ?? sessionPaths.statePath;
  const snapshot = readSnapshotDocument(statePath);

  if (command === "click-screenshot") {
    if (positionals.length < 2) {
      throw new Error("click-screenshot requires x_px and y_px.");
    }
    const xPx = Number(positionals[0]);
    const yPx = Number(positionals[1]);
    const { point, error } = screenshotPixelToScreenPoint(snapshot, xPx, yPx);
    if (!point) {
      throw new Error(error ?? "Failed to map screenshot pixel coordinates.");
    }
    return {
      command: "click-point",
      args: [String(point.x), String(point.y), ...options],
    };
  }

  if (positionals.length < 4) {
    throw new Error(
      "drag-screenshot requires from_x_px, from_y_px, to_x_px, and to_y_px.",
    );
  }

  const fromX = Number(positionals[0]);
  const fromY = Number(positionals[1]);
  const toX = Number(positionals[2]);
  const toY = Number(positionals[3]);
  const fromPoint = screenshotPixelToScreenPoint(snapshot, fromX, fromY);
  if (!fromPoint.point) {
    throw new Error(fromPoint.error ?? "Failed to map drag start screenshot coordinates.");
  }
  const toPoint = screenshotPixelToScreenPoint(snapshot, toX, toY);
  if (!toPoint.point) {
    throw new Error(toPoint.error ?? "Failed to map drag end screenshot coordinates.");
  }

  return {
    command: "drag",
    args: [
      String(fromPoint.point.x),
      String(fromPoint.point.y),
      String(toPoint.point.x),
      String(toPoint.point.y),
      ...options,
    ],
  };
};

const snapshotLockKeys = (snapshot: SnapshotDocument | null, statePath: string) => {
  const keys: string[] = [];
  if (snapshot?.appName) {
    keys.push(`app-${normalizeLockKey(snapshot.appName)}`);
  }
  if (snapshot?.bundleId) {
    keys.push(`bundle-${normalizeLockKey(snapshot.bundleId)}`);
  }
  if (typeof snapshot?.pid === "number" && Number.isFinite(snapshot.pid)) {
    keys.push(`pid-${snapshot.pid}`);
  }
  return keys.length > 0 ? keys : [fallbackStateLockKey(statePath)];
};

const resolveLockKeys = (
  command: string,
  args: string[],
  sessionPaths: SessionPaths,
) => {
  if (command === "list-apps") {
    return [];
  }

  const keys = new Set<string>();

  if (command === "snapshot") {
    const pidValue = getOptionValue(args, "--pid");
    const bundleId = getOptionValue(args, "--bundle-id");
    const appName = getOptionValue(args, "--app");

    if (pidValue) {
      keys.add(`pid-${pidValue}`);
    }
    if (bundleId) {
      keys.add(`bundle-${normalizeLockKey(bundleId)}`);
    }
    if (appName) {
      keys.add(`app-${normalizeLockKey(appName)}`);
    }
    if (keys.size === 0) {
      keys.add("frontmost-app");
    }
  } else {
    const statePath = getOptionValue(args, "--state") ?? sessionPaths.statePath;
    for (const key of snapshotLockKeys(readSnapshotDocument(statePath), statePath)) {
      keys.add(key);
    }
  }

  if (
    command === "drag" ||
    command === "drag-element" ||
    command === "click-point" ||
    command === "type" ||
    command === "press" ||
    (command === "click" && hasOption(args, "--coordinate-fallback"))
  ) {
    keys.add("global-hid");
  }

  return [...keys].sort();
};

const ensureCommandPaths = (command: string, args: string[]) => {
  if (command === "list-apps") {
    return;
  }

  const statePath = getOptionValue(args, "--state");
  if (statePath) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  }

  if (command === "snapshot") {
    const screenshotPath = getOptionValue(args, "--screenshot");
    if (screenshotPath) {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    }
  }
};

const getLockTimeoutMs = () => {
  const parsed = Number(process.env.STELLA_COMPUTER_LOCK_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return defaultLockTimeoutMs;
};

const sleep = async (timeoutMs: number) =>
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));

const acquireLock = async (key: string, sessionId: string) => {
  const lockPath = path.join(locksDir, normalizeLockKey(key) || "lock");
  const deadlineAt = Date.now() + getLockTimeoutMs();

  while (Date.now() <= deadlineAt) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify(
          {
            pid: process.pid,
            key,
            sessionId,
            acquiredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      return () => {
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = fs.statSync(lockPath);
        if (Date.now() - stats.mtimeMs > staleLockTimeoutMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      await sleep(lockPollIntervalMs);
    }
  }

  throw new Error(`Timed out waiting for desktop automation lock: ${key}`);
};

const acquireLocks = async (keys: string[], sessionId: string) => {
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      releases.push(await acquireLock(key, sessionId));
    }
    return () => {
      while (releases.length > 0) {
        const release = releases.pop();
        release?.();
      }
    };
  } catch (error) {
    while (releases.length > 0) {
      const release = releases.pop();
      release?.();
    }
    throw error;
  }
};

const validateHidAccess = (
  command: string,
  args: string[],
  jsonMode: boolean,
) => {
  if (command === "click" && hasOption(args, "--coordinate-fallback") && !hidAllowed(args)) {
    emitError(
      {
        ok: false,
        error:
          "Coordinate fallback requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1.",
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }

  if (
    (command === "drag" ||
      command === "drag-element" ||
      command === "click-point" ||
      command === "type" ||
      command === "press") &&
    !hidAllowed(args)
  ) {
    emitError(
      {
        ok: false,
        error:
          `${command} requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1 because it sends global HID events.`,
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }
};

const runCommand = async (
  command: string,
  args: string[],
  jsonMode: boolean,
  sessionOverride?: string | null,
): Promise<number> => {
  const sessionPaths = resolveSessionPaths(sessionOverride);
  ensureStateDirectory(sessionPaths);

  let effectiveCommand = command === "get-state" ? "snapshot" : command;
  let effectiveArgs = args;
  try {
    const translated = translateScreenshotCoordinateCommand(effectiveCommand, args, sessionPaths);
    effectiveCommand = translated.command;
    effectiveArgs = translated.args;
  } catch (error) {
    emitError(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }

  const initialHelperArgs =
    effectiveCommand === "list-apps"
      ? ["list-apps"]
      : effectiveCommand === "snapshot"
      ? ["snapshot", ...ensureSnapshotArgs(effectiveArgs, sessionPaths)]
      : [effectiveCommand, ...withStatePath(effectiveArgs, sessionPaths)];
  const statePathForCommand =
    getOptionValue(initialHelperArgs.slice(1), "--state") ?? sessionPaths.statePath;

  validateHidAccess(effectiveCommand, initialHelperArgs.slice(1), jsonMode);
  ensureCommandPaths(effectiveCommand, initialHelperArgs.slice(1));

  let releaseLocks: (() => void) | undefined;
  try {
    releaseLocks = await acquireLocks(
      resolveLockKeys(effectiveCommand, initialHelperArgs.slice(1), sessionPaths),
      sessionPaths.sessionId,
    );
  } catch (error) {
    emitError(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
        screenshotPath: null,
      },
      jsonMode,
    );
  }

  try {
    const { helperArgs, daemonActive } = await maybePrimePersistentOverlay(
      effectiveCommand,
      initialHelperArgs,
      sessionPaths,
    );
    // Gate the actual HID dispatch on the daemon's recovered Codex
    // `nextInteractionTiming.closeEnough` deadline so the real click
    // lands at the same moment the cursor's press pulse fires
    // visually, instead of after the full move completes. Only applies
    // to click-like interactions; for everything else
    // `actionReadyAtMs` equals `busyUntilMs` so the early release is a
    // no-op anyway.
    if (daemonActive && commandIsClickLike(effectiveCommand)) {
      await waitForOverlayActionReady(sessionPaths);
    }
    const result = await runNativeHelper({
      helperName: "desktop_automation",
      helperArgs,
      env: {
        ...process.env,
        STELLA_COMPUTER_SESSION: sessionPaths.sessionId,
      },
    });
    if (daemonActive) {
      // The daemon's animation usually outlasts the helper's actual
      // mouse-down/up. Hold the wrapper open until the move has
      // visually finished, otherwise the next `bun stella-computer`
      // invocation can race in and overwrite the in-flight `show`
      // command before the cursor reaches its destination.
      await waitForOverlayIdle(sessionPaths);
    }

    if (result.error) {
      throw result.error;
    }
    if (result.timedOut) {
      const payload = {
        ok: false,
        error: result.stderr || "desktop_automation timed out",
        warnings: result.stdout ? ["Partial helper output was discarded after timeout."] : [],
        screenshotPath: null,
      } satisfies ErrorPayload;
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        formatError(payload);
      }
      return 1;
    }
    if (!result.stdout) {
      const payload = {
        ok: false,
        error: result.stderr || "desktop_automation returned no output",
        warnings: [],
        screenshotPath: null,
      } satisfies ErrorPayload;
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        formatError(payload);
      }
      return 1;
    }

    if (jsonMode) {
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith("\n")) {
        process.stdout.write("\n");
      }
      return result.status === 0 ? 0 : 1;
    }

    const parsed = parseJson<
      SnapshotDocument | ActionPayload | ListAppsPayload | ErrorPayload
    >(result.stdout);

    if (!parsed.ok) {
      formatError(parsed as ErrorPayload);
      return 1;
    }

    if (effectiveCommand === "list-apps") {
      formatListApps(parsed as ListAppsPayload);
    } else if (effectiveCommand === "snapshot") {
      formatSnapshot(readSnapshotDocument(statePathForCommand) ?? parsed as SnapshotDocument);
    } else {
      formatAction(parsed as ActionPayload, readSnapshotDocument(statePathForCommand));
    }

    return 0;
  } finally {
    releaseLocks?.();
  }
};

const rawArgv = process.argv.slice(2);
const {
  value: sessionOverride,
  args: argv,
  missingValue: missingSessionValue,
} = stripOptionValue(rawArgv, "--session");

if (missingSessionValue) {
  process.stderr.write("--session requires a value.\n");
  process.exit(1);
}

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write(usage);
  process.exit(0);
}

if (process.platform !== "darwin") {
  process.stderr.write("stella-computer is currently only available on macOS.\n");
  process.exit(1);
}

const command = argv[0];
const restArgs = argv.slice(1);
const { found: jsonMode, args: plainArgs } = stripFlag(restArgs, "--json");

if (
  ![
    "list-apps",
    "snapshot",
    "get-state",
    "click",
    "fill",
    "focus",
    "secondary-action",
    "perform-secondary-action",
    "scroll",
    "drag",
    "drag-element",
    "click-point",
    "click-screenshot",
    "drag-screenshot",
    "type",
    "press",
  ].includes(command)
) {
  process.stderr.write(`Unknown command: ${command}\n\n${usage}`);
  process.exit(1);
}

void (async () => {
  try {
    const exitCode = await runCommand(command, plainArgs, jsonMode, sessionOverride);
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
})();
