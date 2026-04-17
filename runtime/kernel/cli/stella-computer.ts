#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { resolveStatePath } from "./shared.js";
import { runNativeHelper } from "./native-helper.js";
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
  ref?: string | null;
  role: string;
  subrole?: string | null;
  title?: string | null;
  description?: string | null;
  value?: string | null;
  identifier?: string | null;
  url?: string | null;
  enabled?: boolean | null;
  focused?: boolean | null;
  selected?: boolean | null;
  frame?: Rect | null;
  actions: string[];
  children: SnapshotNode[];
};

type SnapshotDocument = {
  ok: boolean;
  appName: string;
  bundleId?: string | null;
  pid: number;
  windowTitle?: string | null;
  windowFrame?: Rect | null;
  nodeCount: number;
  refCount: number;
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
  stella-computer [--session ID] click <ref> [--coordinate-fallback] [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise] [--no-overlay]
  stella-computer [--session ID] fill <ref> <text> [--no-screenshot] [--no-inline-screenshot] [--no-raise] [--no-overlay]
  stella-computer [--session ID] focus <ref> [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] secondary-action <ref> <action> [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] scroll <ref> <up|down|left|right> [--pages N] [--no-screenshot] [--no-inline-screenshot] [--no-overlay]
  stella-computer [--session ID] drag <from_x> <from_y> <to_x> <to_y> [--allow-hid] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] drag-element <source-ref> (<dest-ref> | <to_x> <to_y> | --to-ref REF | --to-x N --to-y N) [--type file|url|text] [--operation copy|link|move|every] [--allow-hid] [--no-screenshot] [--no-inline-screenshot]
  stella-computer [--session ID] click-point <x> <y> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]
  stella-computer [--session ID] type <text> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]
  stella-computer [--session ID] press <key> [--allow-hid] [--no-screenshot] [--no-inline-screenshot] [--no-raise]

Notes:
  - snapshot writes ref state to ${defaultSessionStateExample}
  - click/fill/focus/secondary-action/scroll/drag reuse the last snapshot state unless --state is provided
  - snapshot captures a window screenshot by default; pass --no-screenshot to skip it
  - --all-windows enumerates every accessibility window the app advertises (default: focused only)
  - successful actions refresh refs and the attached screenshot automatically
  - screenshots are auto-attached inline (base64 PNG); pass --no-inline-screenshot to keep only the file path
  - the agent runtime detects "[stella-attach-image]" markers in output and attaches the image as vision input on the next turn
  - Stella isolates default state/screenshot files by session; agent runs set that session automatically
  - HID fallbacks require --allow-hid (or STELLA_COMPUTER_ALLOW_HID=1) because they can interfere with active user input
  - ref actions use macOS Accessibility first, which avoids taking over the physical cursor
  - --no-raise (or STELLA_COMPUTER_NO_RAISE=1) avoids bringing the target app frontmost during click/type/press
  - actions show a brief lens + software-cursor overlay around the target (~700ms); pass --no-overlay (or STELLA_COMPUTER_NO_OVERLAY=1) to skip it for chained-action latency
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

const deriveScreenshotPath = (statePath: string) => {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, `${parsed.name}.png`);
};

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

// "AXScrollArea" -> "scroll area". This matches the Codex Computer Use
// rendering format ("4 menu bar", "0 scroll area (disabled) desktop") which
// is significantly more token-efficient than the raw kAX role names and is
// what the model is most familiar with from Codex training data.
const humanRole = (role: string): string => {
  const trimmed = role.startsWith("AX") ? role.slice(2) : role;
  // Insert a space before any uppercase letter that follows a lowercase one.
  return trimmed
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
};

const refSuffixForActions = (actions: string[]): string => {
  // Codex surfaces the union of *user-callable* secondary actions next to the
  // node so the model can immediately call them via `perform_secondary_action`
  // without re-snapshotting. We mirror that filter rule here: AXPress is
  // implicit (every clickable node has it), the rest are surfaced verbatim.
  const surfaced = actions.filter((action) => action !== "AXPress");
  if (surfaced.length === 0) return "";
  return `, Secondary Actions: ${surfaced.join(", ")}`;
};

// Codex-style flat-list rendering. One node per line, tab-indent per depth,
// `<id> <role>[ (<state-flags>)] [<label>][, Secondary Actions: ...][, ID: ...]`.
// Stella refs (e.g. `@d12`) are kept as the leading token because callers
// invoke actions with them — switching to bare integers would break the CLI.
const formatNodeLinesCodex = (node: SnapshotNode, depth = 0): string[] => {
  const indent = "\t".repeat(depth);
  const id = node.ref ?? "_";
  const role = humanRole(node.role);

  const stateFlags: string[] = [];
  if (node.enabled === false) stateFlags.push("disabled");
  if (node.selected) stateFlags.push("selected");
  if (node.focused) stateFlags.push("focused");
  const stateSegment = stateFlags.length > 0 ? ` (${stateFlags.join(", ")})` : "";

  const rawLabel =
    node.title ?? node.description ?? node.value ?? node.identifier ?? null;
  const label = rawLabel ? ` ${truncate(rawLabel, 120)}` : "";

  const idTag = node.identifier && node.identifier !== rawLabel
    ? `, ID: ${node.identifier}`
    : "";

  const urlTag = node.url ? `, URL: ${truncate(node.url, 100)}` : "";

  const actions = refSuffixForActions(node.actions ?? []);

  const line = `${indent}${id} ${role}${stateSegment}${label}${actions}${idTag}${urlTag}`;
  return [line, ...node.children.flatMap((child) => formatNodeLinesCodex(child, depth + 1))];
};

const findFocusedRef = (nodes: SnapshotNode[]): string | null => {
  for (const node of nodes) {
    if (node.focused && node.ref) return node.ref;
    const nested = findFocusedRef(node.children);
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
  return `\n--- App-specific instructions ---\n${trimmed}\n--- end app-specific instructions ---\n`;
};

const formatSnapshot = (snapshot: SnapshotDocument) => {
  // Codex Computer Use's verbatim rendering format. The model is trained on
  // exactly this shape so it pattern-matches snapshots quickly:
  //
  //   <stella_computer_state cua_version=...>
  //   App=com.apple.finder (pid 504)
  //   Window: "Desktop", App: Finder.
  //       0 menu bar
  //           1 Finder
  //           ...
  //   The focused UI element is @d3 button.
  //   </stella_computer_state>
  process.stdout.write("<stella_computer_state>\n");
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
  const focusedRef = findFocusedRef(snapshot.nodes);
  if (focusedRef) {
    process.stdout.write(`The focused UI element is ${focusedRef}.\n`);
  }
  process.stdout.write("</stella_computer_state>\n");

  // After the structured state block, emit metadata + auto-attach hints +
  // app-specific instructions. The order matters: the screenshot marker
  // comes immediately after </stella_computer_state> so any host that
  // attaches the image renders it adjacent to the tree.
  process.stdout.write(formatScreenshotMarker(snapshot.screenshot, snapshot.screenshotPath));
  process.stdout.write(formatAppInstructions(snapshot.appInstructions));
  printWarnings(snapshot.warnings);
};

const formatAction = (payload: ActionPayload) => {
  process.stdout.write(payload.message);
  if (payload.usedAction) {
    process.stdout.write(` (${payload.usedAction})`);
  }
  process.stdout.write("\n");
  process.stdout.write(formatScreenshotMarker(payload.screenshot, payload.screenshotPath));
  process.stdout.write(formatAppInstructions(payload.appInstructions));
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

  const helperArgs =
    command === "list-apps"
      ? ["list-apps"]
      : command === "snapshot"
      ? ["snapshot", ...ensureSnapshotArgs(args, sessionPaths)]
      : [command, ...withStatePath(args, sessionPaths)];

  validateHidAccess(command, helperArgs.slice(1), jsonMode);
  ensureCommandPaths(command, helperArgs.slice(1));

  let releaseLocks: (() => void) | undefined;
  try {
    releaseLocks = await acquireLocks(
      resolveLockKeys(command, helperArgs.slice(1), sessionPaths),
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
    const result = await runNativeHelper({
      helperName: "desktop_automation",
      helperArgs,
      env: {
        ...process.env,
        STELLA_COMPUTER_SESSION: sessionPaths.sessionId,
      },
    });

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

    if (command === "list-apps") {
      formatListApps(parsed as ListAppsPayload);
    } else if (command === "snapshot") {
      formatSnapshot(parsed as SnapshotDocument);
    } else {
      formatAction(parsed as ActionPayload);
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
    "click",
    "fill",
    "focus",
    "secondary-action",
    "perform-secondary-action",
    "scroll",
    "drag",
    "drag-element",
    "click-point",
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
