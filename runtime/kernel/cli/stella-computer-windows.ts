import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runNativeHelper } from "./native-helper.js";
import { resolveStatePath } from "./shared.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";

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
  windowTitle?: string;
  windowBounds?: WinFrame | null;
  screenshotPngBase64?: string | null;
  treeLines?: string[];
  focusedSummary?: string | null;
  selectedText?: string | null;
  elements?: WinElementRecord[];
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
  windowBounds?: WinFrame | null;
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
  };
};

const stateDir = path.join(resolveStatePath(), "stella-computer");
const defaultSessionId = "manual";
const windowsHelperName = "stella-computer-helper";
const windowsHelperTimeoutMs = 30_000;

const usage = `stella-computer - control Windows apps through UI Automation and Win32 messages

Usage:
  stella-computer list-apps
  stella-computer [--session ID] snapshot (--app NAME|--bundle-id ID|--pid PID) [--json]
  stella-computer [--session ID] get-state (--app NAME|--bundle-id ID|--pid PID) [--json]
  stella-computer [--session ID] click <element> [--app NAME] [--mouse-button left|right|middle] [--click-count N]
  stella-computer [--session ID] fill <element> <text> [--app NAME]
  stella-computer [--session ID] secondary-action <element> <action> [--app NAME]
  stella-computer [--session ID] scroll <element> <up|down|left|right> [--app NAME] [--pages N]
  stella-computer [--session ID] click-screenshot <x_px> <y_px> [--app NAME] [--mouse-button left|right|middle] [--click-count N]
  stella-computer [--session ID] drag-screenshot <from_x_px> <from_y_px> <to_x_px> <to_y_px> [--app NAME]
  stella-computer [--session ID] type <text> [--app NAME]
  stella-computer [--session ID] press <key> [--app NAME]

Notes:
  - snapshot writes element state under state/stella-computer/sessions/<session>/windows-targets/
  - actions reuse the last snapshot for the target app and refresh it after each action
  - Windows uses the bundled stella-computer-helper.exe native helper
  - the helper uses UI Automation patterns first and Win32 window messages as fallback
  - app launch, SetFocus, and UIA text fallback are opt-in via STELLA_COMPUTER_WINDOWS_ALLOW_* env flags
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
  path.join(sessionDir(sessionId), normalizeTargetKey(app), "last-snapshot.json");

const targetScreenshotPath = (sessionId: string, app: string) =>
  path.join(sessionDir(sessionId), normalizeTargetKey(app), "last-screenshot.png");

const readSnapshot = (sessionId: string, app: string): WinSnapshot | null => {
  try {
    return JSON.parse(fs.readFileSync(targetStatePath(sessionId, app), "utf8")) as WinSnapshot;
  } catch {
    return null;
  }
};

const rememberSnapshot = (sessionId: string, app: string, snapshot: WinSnapshot) => {
  const aliases = new Set([
    app,
    snapshot.app.name,
    snapshot.app.bundleIdentifier,
    String(snapshot.app.pid),
  ].filter((value): value is string => Boolean(value)));

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

const runWindowsHelper = async (request: WinHelperRequest): Promise<WinHelperResponse> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-computer-windows-"));
  const operationPath = path.join(tempDir, "operation.json");
  try {
    fs.writeFileSync(operationPath, JSON.stringify(request), { mode: 0o600 });

    const result = await runNativeHelper({
      helperName: windowsHelperName,
      helperArgs: [operationPath],
      timeoutMs: windowsHelperTimeoutMs,
      env: process.env,
    });

    if (result.timedOut) {
      throw new Error(`Windows stella-computer helper timed out after ${windowsHelperTimeoutMs}ms`);
    }
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `Windows stella-computer helper exited ${result.status}`,
      );
    }

    try {
      return JSON.parse(result.stdout) as WinHelperResponse;
    } catch (error) {
      throw new Error(
        `Windows stella-computer helper returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }: ${result.stdout.trim() || result.stderr.trim()}`,
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
  if (app.missingValue || bundle.missingValue || pid.missingValue) {
    throw new Error("--app, --bundle-id, and --pid require a value.");
  }
  const target = app.value ?? bundle.value ?? pid.value;
  if (!target) {
    throw new Error("Windows stella-computer requires --app, --bundle-id, or --pid.");
  }
  return { app: target, args: nextArgs };
};

const appFromActionArgs = (sessionId: string, args: string[]) => {
  let nextArgs = args;
  const app = stripOptionValue(nextArgs, "--app");
  nextArgs = app.args;
  const bundle = stripOptionValue(nextArgs, "--bundle-id");
  nextArgs = bundle.args;
  const pid = stripOptionValue(nextArgs, "--pid");
  nextArgs = pid.args;
  if (app.missingValue || bundle.missingValue || pid.missingValue) {
    throw new Error("--app, --bundle-id, and --pid require a value.");
  }
  const target = app.value ?? bundle.value ?? pid.value;
  if (target) {
    return { app: target, args: nextArgs };
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
    const snapshot = JSON.parse(fs.readFileSync(candidates[0]!, "utf8")) as WinSnapshot;
    return { app: snapshot.app.bundleIdentifier ?? snapshot.app.name, args: nextArgs };
  }
  throw new Error("Action commands require --app on Windows unless the session has exactly one cached snapshot.");
};

const getOptionValue = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
};

const splitWindowsArgs = (args: string[]) => {
  const positionals: string[] = [];
  const valueOptions = new Set([
    "--app",
    "--bundle-id",
    "--pid",
    "--mouse-button",
    "--click-count",
    "--pages",
    "--state",
  ]);
  const booleanOptions = new Set([
    "--allow-hid",
    "--raise",
    "--no-raise",
    "--no-screenshot",
    "--no-inline-screenshot",
    "--no-overlay",
    "--json",
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
    throw new Error(`No app state is available for ${app}. Run stella-computer snapshot before action commands.`);
  }
  return snapshot;
};

const frameImageBytes = (snapshot: WinSnapshot) =>
  snapshot.screenshotPngBase64 ? Buffer.from(snapshot.screenshotPngBase64, "base64") : null;

const formatScreenshotMarker = (sessionId: string, app: string, snapshot: WinSnapshot) => {
  if (!snapshot.screenshotPngBase64) return "";
  const bytes = frameImageBytes(snapshot);
  const path = targetScreenshotPath(sessionId, app);
  const dims = snapshot.windowBounds
    ? ` ${Math.round(snapshot.windowBounds.width)}x${Math.round(snapshot.windowBounds.height)}`
    : "";
  const sizeKb = bytes ? ` ${(bytes.byteLength / 1024).toFixed(0)}KB` : "";
  return `[stella-attach-image]${dims}${sizeKb} inline=image/png ${path}\n`;
};

const formatSnapshot = (sessionId: string, app: string, snapshot: WinSnapshot) => {
  process.stdout.write("<app_state>\n");
  const appRef = snapshot.app.bundleIdentifier || snapshot.app.name;
  process.stdout.write(`App=${appRef} (pid ${snapshot.app.pid})\n`);
  const title = snapshot.windowTitle || snapshot.app.name;
  process.stdout.write(`Window: "${title}", App: ${snapshot.app.name}.\n`);
  for (const line of snapshot.treeLines ?? []) {
    process.stdout.write(`${line}\n`);
  }
  if (snapshot.selectedText) {
    process.stdout.write(`\nSelected text: [${snapshot.selectedText}]\n`);
  } else if (snapshot.focusedSummary) {
    process.stdout.write(`\nThe focused UI element is ${snapshot.focusedSummary}.\n`);
  }
  process.stdout.write("</app_state>\n");
  process.stdout.write(formatScreenshotMarker(sessionId, app, snapshot));
};

const emitJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const runSnapshot = async (sessionId: string, app: string, jsonMode: boolean) => {
  const response = await runWindowsHelper({ tool: "get_app_state", app });
  if (!response.ok || !response.snapshot) {
    throw new Error(response.error || "Windows runtime did not return an app snapshot.");
  }
  rememberSnapshot(sessionId, app, response.snapshot);
  if (jsonMode) {
    emitJson(response.snapshot);
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
  const response = await runWindowsHelper(request);
  if (!response.ok || !response.snapshot) {
    throw new Error(response.error || "Windows runtime did not return an app snapshot.");
  }
  rememberSnapshot(sessionId, app, response.snapshot);
  if (jsonMode) {
    emitJson({ receipt: response.receipt ?? null, snapshot: response.snapshot });
  } else {
    if (response.receipt) {
      process.stdout.write(
        `Action receipt: route=${response.receipt.route ?? "unknown"} background_safe=${
          response.receipt.background_safe === true ? "true" : "false"
        } cursor_moved=${response.receipt.cursor_moved === true ? "true" : "false"} foreground_changed=${
          response.receipt.foreground_changed === true ? "true" : "false"
        }\n`,
      );
    }
    process.stdout.write(`${request.tool} completed.\n`);
    formatSnapshot(sessionId, app, response.snapshot);
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
    const response = await runWindowsHelper({ tool: "list_apps" });
    if (!response.ok) {
      throw new Error(response.error || "Windows runtime failed to list apps.");
    }
    process.stdout.write(response.text?.trimEnd() || "No running top-level apps are visible to this Windows runtime.");
    process.stdout.write("\n");
    return 0;
  }

  if (command === "snapshot" || command === "get-state") {
    const target = appFromSnapshotArgs(args);
    await runSnapshot(sessionId, target.app, jsonMode);
    return 0;
  }

  if (command === "click") {
    const target = appFromActionArgs(sessionId, args);
    const element = splitWindowsArgs(target.args)[0];
    if (!element) throw new Error("click requires an element index.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    const record = lookupElement(snapshot, element);
    const button = getOptionValue(target.args, "--mouse-button") ?? "left";
    const countRaw = Number(getOptionValue(target.args, "--click-count") ?? "1");
    await runAction(sessionId, target.app, {
      tool: "click",
      app: target.app,
      element: record,
      mouse_button: button,
      click_count: Number.isFinite(countRaw) ? Math.max(1, Math.trunc(countRaw)) : 1,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "click-screenshot") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    if (positionals.length < 2) throw new Error("click-screenshot requires x_px and y_px.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    const x = Number(positionals[0]);
    const y = Number(positionals[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("click-screenshot coordinates must be finite numbers.");
    }
    const button = getOptionValue(target.args, "--mouse-button") ?? "left";
    const countRaw = Number(getOptionValue(target.args, "--click-count") ?? "1");
    await runAction(sessionId, target.app, {
      tool: "click",
      app: target.app,
      x,
      y,
      mouse_button: button,
      click_count: Number.isFinite(countRaw) ? Math.max(1, Math.trunc(countRaw)) : 1,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "drag-screenshot") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    if (positionals.length < 4) {
      throw new Error("drag-screenshot requires from_x_px, from_y_px, to_x_px, and to_y_px.");
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const [fromX, fromY, toX, toY] = positionals.slice(0, 4).map(Number);
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      throw new Error("drag-screenshot coordinates must be finite numbers.");
    }
    await runAction(sessionId, target.app, {
      tool: "drag",
      app: target.app,
      from_x: fromX,
      from_y: fromY,
      to_x: toX,
      to_y: toY,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "fill") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, ...textParts] = positionals;
    if (!element) throw new Error("fill requires an element index.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "set_value",
      app: target.app,
      element: lookupElement(snapshot, element),
      value: textParts.join(" "),
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "secondary-action" || command === "perform-secondary-action") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, action] = positionals;
    if (!element || !action) throw new Error("secondary-action requires an element index and action.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "perform_secondary_action",
      app: target.app,
      element: lookupElement(snapshot, element),
      action,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "scroll") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, direction] = positionals;
    if (!element || !direction) throw new Error("scroll requires an element index and direction.");
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`);
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const pages = Number(getOptionValue(target.args, "--pages") ?? "1");
    await runAction(sessionId, target.app, {
      tool: "scroll",
      app: target.app,
      element: lookupElement(snapshot, element),
      direction,
      pages: Number.isFinite(pages) && pages > 0 ? pages : 1,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "type") {
    const target = appFromActionArgs(sessionId, args);
    const text = splitWindowsArgs(target.args).join(" ");
    if (!text) throw new Error("type requires text.");
    requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "type_text",
      app: target.app,
      text,
    }, jsonMode);
    return 0;
  }

  if (command === "press") {
    const target = appFromActionArgs(sessionId, args);
    const key = splitWindowsArgs(target.args)[0];
    if (!key) throw new Error("press requires a key.");
    requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "press_key",
      app: target.app,
      key,
    }, jsonMode);
    return 0;
  }

  if (command === "doctor") {
    process.stdout.write(
      [
        "Windows runtime: stella-computer-helper.exe is used when Stella runs in the signed-in desktop session.",
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
