import {
  app,
  BrowserWindow,
  contentTracing,
  dialog,
  ipcMain,
  powerSaveBlocker,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { spawn } from "node:child_process";
import { access, copyFile, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMainLogger } from "../observability/main-logger.js";
import { resolveLogPaths } from "../../../runtime/observability/log-paths.js";
import {
  getLocalModelPreferences,
  getOnboardingCompleted,
  getPersonalityVoiceId,
  setPersonalityVoiceId,
  getPreventComputerSleep,
  getReadAloudEnabled,
  setReadAloudEnabled,
  getCadenceReportsPreferences,
  setCadenceReportsPreferences,
  getSoundNotificationsEnabled,
  getSyncMode,
  loadLocalPreferences,
  normalizeImageGenerationPreferences,
  normalizeRealtimeVoicePreferences,
  saveLocalPreferences,
  setOnboardingCompleted,
  updateLocalModelPreferences,
  type CadenceReportsPreferences,
  type LocalModelPreferencesSnapshot,
  type ReasoningEffort,
} from "../../../runtime/kernel/preferences/local-preferences.js";
import { coerceAgentRuntimeEngine } from "../../../runtime/contracts/agent-engine.js";
import {
  coercePersonalityId,
  isKnownPersonalityId,
} from "../../../runtime/contracts/personality.js";
import { writePersonality } from "../../../runtime/kernel/personality/personality.js";
import { listCodexAppServerModels } from "../../../runtime/kernel/integrations/codex-agent-runtime.js";
import { listClaudeCodeModels } from "../../../runtime/kernel/integrations/claude-code-session-runtime.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { AuthService } from "../services/auth-service.js";
import type { BackupService } from "../services/backup-service.js";
import type { ExternalLinkService } from "../services/external-link-service.js";
import {
  deleteLocalLlmCredential,
  getLocalLlmCredential,
  listLocalLlmCredentials,
  saveLocalLlmCredential,
} from "../../../runtime/kernel/storage/llm-credentials.js";
import {
  deleteLocalLlmOAuthCredential,
  getLocalLlmOAuthApiKey,
  listLocalLlmOAuthCredentials,
  saveLocalLlmOAuthCredential,
} from "../../../runtime/kernel/storage/llm-oauth-credentials.js";
import {
  getOAuthProvider,
  getOAuthProviders,
} from "../../../runtime/ai/utils/oauth/index.js";
import type { RuntimeSocialSessionStatus } from "../../../runtime/protocol/index.js";
import { isRuntimeUnavailableError } from "../../../runtime/protocol/rpc-peer.js";
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  normalizeRadialTriggerCode,
  type RadialTriggerCode,
} from "../../src/shared/lib/radial-trigger.js";
import {
  normalizeMiniDoubleTapModifier,
  type MiniDoubleTapModifier,
} from "../../src/shared/lib/mini-double-tap.js";
import {
  IPC_APP_QUIT_FOR_RESTART,
  IPC_AUTH_APPLY_SESSION_COOKIE,
  IPC_AUTH_CONSUME_PENDING_CALLBACK,
  IPC_AUTH_DELETE_USER,
  IPC_AUTH_GET_CONVEX_TOKEN,
  IPC_AUTH_GET_SESSION,
  IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
  IPC_AUTH_SIGN_IN_ANONYMOUS,
  IPC_AUTH_SIGN_OUT,
  IPC_AUTH_VERIFY_CALLBACK_URL,
  IPC_BACKUP_GET_STATUS,
  IPC_BACKUP_LIST,
  IPC_BACKUP_RESTORE,
  IPC_BACKUP_RUN_NOW,
  IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
  IPC_DIAGNOSTICS_REPORT_ERROR,
  IPC_DIAGNOSTICS_OPEN_LOGS,
  IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
  IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
  IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT,
  IPC_SYSTEM_OPEN_FDA,
  IPC_SOCIAL_SESSIONS_CREATE,
  IPC_SOCIAL_SESSIONS_GET_STATUS,
  IPC_PERMISSIONS_GET_STATUS,
  IPC_PERMISSIONS_OPEN_SETTINGS,
  IPC_PERMISSIONS_REQUEST,
  IPC_PERMISSIONS_RESET,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_SHELL_SAVE_FILE_AS,
  IPC_PREFERENCES_GET_RADIAL_TRIGGER,
  IPC_PREFERENCES_GET_MINI_DOUBLE_TAP,
  IPC_PREFERENCES_GET_PERSONALITY_VOICE,
  IPC_PREFERENCES_SET_PERSONALITY_VOICE,
  IPC_PREFERENCES_GET_MODELS,
  IPC_PREFERENCES_LIST_CODEX_MODELS,
  IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_GET_PREVENT_SLEEP,
  IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_GET_SYNC_MODE,
  IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_SET_RADIAL_TRIGGER,
  IPC_PREFERENCES_SET_MINI_DOUBLE_TAP,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_SET_PREVENT_SLEEP,
  IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_SET_SYNC_MODE,
  IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_GET_READ_ALOUD,
  IPC_PREFERENCES_SET_READ_ALOUD,
  IPC_PREFERENCES_GET_CADENCE_REPORTS,
  IPC_PREFERENCES_SET_CADENCE_REPORTS,
  IPC_SOCIAL_SESSIONS_QUEUE_TURN,
  IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
} from "../../src/shared/contracts/ipc-channels.js";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import {
  hasMacPermission,
  clearPermissionCache,
  getMicrophonePermissionStatus,
  requestMacPermission,
  resetMacMicrophonePermissions,
  resetMacPermission,
  type MacPermissionKind,
  type MacPermissionSettingsKind,
  type ResettableMacPermissionKind,
} from "../utils/macos-permissions.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import {
  getGlobalShortcutsSuspended,
  setGlobalShortcutsSuspended,
} from "./global-shortcuts.js";

import { createRequire } from "node:module";

type ScreenCapturePermissionsModule = {
  hasPromptedForPermission: () => boolean;
  openSystemPreferences: () => Promise<void>;
};

let _screenCapturePermissions:
  | ScreenCapturePermissionsModule
  | null
  | undefined;
const getScreenCapturePermissions =
  (): ScreenCapturePermissionsModule | null => {
    if (_screenCapturePermissions !== undefined)
      return _screenCapturePermissions;
    try {
      const req = createRequire(import.meta.url);
      _screenCapturePermissions = req(
        "mac-screen-capture-permissions",
      ) as ScreenCapturePermissionsModule;
    } catch {
      _screenCapturePermissions = null;
    }
    return _screenCapturePermissions;
  };

const screenCapturePermissionsHasPrompted = (
  mod: ScreenCapturePermissionsModule | null,
) => {
  if (!mod) {
    return false;
  }

  try {
    return mod.hasPromptedForPermission();
  } catch {
    return false;
  }
};

const openScreenCaptureSystemPreferences = async (
  mod: ScreenCapturePermissionsModule | null,
) => {
  if (!mod) {
    return false;
  }

  try {
    await mod.openSystemPreferences();
    return true;
  } catch {
    return false;
  }
};

const permissionSettingsUrlByKind: Record<MacPermissionSettingsKind, string> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

const openMacPermissionSettings = async (kind: MacPermissionSettingsKind) => {
  const url = permissionSettingsUrlByKind[kind];
  if (!url) {
    return { opened: false, url: null as string | null };
  }
  await shell.openExternal(url);
  return { opened: true, url };
};

/**
 * Touch a few TCC-protected paths from the main process so macOS records the
 * Stella.app bundle as a Full Disk Access client. Until an app actually
 * *attempts* to read protected data, it never appears in
 * System Settings → Privacy & Security → Full Disk Access — so the user opens
 * the pane and Stella isn't in the list, forcing them to add it by hand. The
 * reads are expected to fail with EPERM when access hasn't been granted yet;
 * the TCC registration side-effect is what we're after, so all errors are
 * swallowed. Mirrors `registerStellaForScreenRecording` in macos-permissions.
 */
const registerStellaForFullDiskAccess = async () => {
  if (process.platform !== "darwin") return;
  const home = os.homedir();
  await Promise.allSettled([
    readFile(
      path.join(
        home,
        "Library",
        "Application Support",
        "com.apple.TCC",
        "TCC.db",
      ),
    ),
    readdir(path.join(home, "Library", "Safari")),
    readdir(path.join(home, "Library", "Containers", "com.apple.stocks")),
  ]);
};

const clampHeapTraceDurationMs = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5_000;
  return Math.min(30_000, Math.max(1_000, Math.floor(parsed)));
};

/**
 * Best-effort detection for "this user already runs other AI dev tooling".
 * Used by the onboarding engine phase to hide BYOK / Claude Code surfaces
 * from non-technical users while leaving them visible for anyone who has
 * Claude desktop, ChatGPT desktop, Cursor, or common coding CLIs on this
 * machine. Strictly read-only: only checks well-known install paths and
 * walks `$PATH` for the two CLI bins. No subprocess spawning.
 */
type TechnicalUserSignal =
  | "claude-app"
  | "chatgpt-app"
  | "cursor-app"
  | "claude-cli"
  | "codex-cli"
  | "opencode-cli"
  | "pi-cli"
  | "openclaw-cli"
  | "hermes-cli";

const macAppPaths = (appName: string): string[] => {
  const home = os.homedir();
  return [
    `/Applications/${appName}.app`,
    path.join(home, "Applications", `${appName}.app`),
  ];
};

const winAppPaths = (relPath: string): string[] => {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    path.join(localAppData, relPath),
    path.join(programFiles, relPath),
    path.join(programFilesX86, relPath),
  ];
};

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
};

const anyExistsAsync = async (paths: readonly string[]): Promise<boolean> => {
  if (paths.length === 0) return false;
  const results = await Promise.all(paths.map(pathExists));
  return results.some(Boolean);
};

/**
 * On Windows the simplistic `for (dir in PATH) for (ext in PATHEXT) existsSync(...)`
 * loop is the recurring source of slow onboarding. PATH typically has 30-50
 * entries and PATHEXT defaults to `.EXE;.CMD;.BAT`, so each binary lookup is
 * ~150-300 filesystem hits — and `existsSync` blocks the entire main process.
 *
 * We resolve each binary by running every candidate path through `fs.promises.access`
 * in parallel. NTFS is case-insensitive so the lowercase-vs-uppercase double
 * check the legacy code did is unnecessary; we use PATHEXT as-is.
 */
const findCliOnPathAsync = async (binName: string): Promise<boolean> => {
  const home = os.homedir();
  const wellKnown =
    binName === "claude"
      ? [
          path.join(home, ".claude", "local", "claude"),
          path.join(home, ".claude", "bin", "claude"),
        ]
      : binName === "codex"
        ? [
            path.join(home, ".codex", "bin", "codex"),
            path.join(home, ".cargo", "bin", "codex"),
          ]
        : binName === "opencode"
          ? [
              path.join(home, ".opencode", "bin", "opencode"),
              path.join(home, ".bun", "bin", "opencode"),
            ]
          : binName === "hermes"
            ? // Per Hermes install docs: per-user / pip installer drops
              // `~/.local/bin/hermes` (symlink); root-mode installer drops
              // `/usr/local/bin/hermes`. `~/.local/bin` is often missing
              // from a service user's PATH, so we check it explicitly.
              process.platform === "win32"
              ? []
              : [
                  path.join(home, ".local", "bin", "hermes"),
                  "/usr/local/bin/hermes",
                ]
            : // pi & openclaw: install via npm-global / curl installers
              // that drop `pi` / `openclaw` straight onto PATH; no
              // documented sub-bin path to short-circuit on.
              [];
  if (await anyExistsAsync(wellKnown)) return true;

  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const candidates: string[] = [];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      candidates.push(path.join(dir, `${binName}${ext}`));
    }
  }
  return await anyExistsAsync(candidates);
};

const detectTechnicalUserSignalsAsync = async (): Promise<
  TechnicalUserSignal[]
> => {
  const home = os.homedir();

  // OpenClaw state-dir resolution mirrors the legacy sync path.
  const openclawStateDir =
    process.env.OPENCLAW_STATE_DIR ??
    (process.env.OPENCLAW_HOME
      ? path.join(process.env.OPENCLAW_HOME, ".openclaw")
      : path.join(home, ".openclaw"));

  const hermesDataDirs: string[] = [];
  if (process.env.HERMES_HOME) hermesDataDirs.push(process.env.HERMES_HOME);
  hermesDataDirs.push(path.join(home, ".hermes"));
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    hermesDataDirs.push(path.join(process.env.LOCALAPPDATA, "hermes"));
  }

  // Run every probe in parallel. Each probe resolves to a signal id or null.
  // Wall time is dominated by the slowest single `fs.access`, not the sum of
  // hundreds of sequential calls.
  type ProbeResult = TechnicalUserSignal | null;
  const probes: Promise<ProbeResult>[] = [];

  if (process.platform === "darwin") {
    probes.push(
      anyExistsAsync(macAppPaths("Claude")).then((v) =>
        v ? "claude-app" : null,
      ),
      anyExistsAsync(macAppPaths("ChatGPT")).then((v) =>
        v ? "chatgpt-app" : null,
      ),
      anyExistsAsync(macAppPaths("Cursor")).then((v) =>
        v ? "cursor-app" : null,
      ),
    );
  } else if (process.platform === "win32") {
    probes.push(
      Promise.all([
        anyExistsAsync(winAppPaths("AnthropicClaude\\Claude.exe")),
        anyExistsAsync(winAppPaths("Programs\\Claude\\Claude.exe")),
      ]).then(([a, b]) => (a || b ? "claude-app" : null)),
      anyExistsAsync(winAppPaths("Programs\\OpenAI ChatGPT\\ChatGPT.exe")).then(
        (v) => (v ? "chatgpt-app" : null),
      ),
      anyExistsAsync(winAppPaths("Programs\\Cursor\\Cursor.exe")).then((v) =>
        v ? "cursor-app" : null,
      ),
    );
  }

  probes.push(
    findCliOnPathAsync("claude").then((v) => (v ? "claude-cli" : null)),
    findCliOnPathAsync("codex").then((v) => (v ? "codex-cli" : null)),
    findCliOnPathAsync("opencode").then((v) => (v ? "opencode-cli" : null)),
    Promise.all([
      pathExists(path.join(home, ".pi", "agent")),
      findCliOnPathAsync("pi"),
    ]).then(([a, b]) => (a || b ? "pi-cli" : null)),
    Promise.all([
      pathExists(openclawStateDir),
      pathExists(path.join(home, ".config", "openclaw")),
      findCliOnPathAsync("openclaw"),
    ]).then(([a, b, c]) => (a || b || c ? "openclaw-cli" : null)),
    Promise.all([
      anyExistsAsync(hermesDataDirs),
      findCliOnPathAsync("hermes"),
    ]).then(([a, b]) => (a || b ? "hermes-cli" : null)),
  );

  const results = await Promise.all(probes);
  const seen = new Set<TechnicalUserSignal>();
  for (const value of results) {
    if (value) seen.add(value);
  }
  return Array.from(seen);
};

let technicalUserSignalsPromise: Promise<TechnicalUserSignal[]> | null = null;
const detectTechnicalUserSignalsMemoized = (): Promise<
  TechnicalUserSignal[]
> => {
  // Memoize for the lifetime of the Electron main process. The probe scans
  // ~hundreds of filesystem entries on Windows and the answer can't change
  // mid-session in any way the user cares about.
  if (!technicalUserSignalsPromise) {
    technicalUserSignalsPromise = detectTechnicalUserSignalsAsync().catch(
      (error) => {
        // Reset the cache on failure so a later probe can retry.
        technicalUserSignalsPromise = null;
        throw error;
      },
    );
  }
  return technicalUserSignalsPromise;
};

type SystemHandlersOptions = {
  getDeviceId: () => string | null;
  authService: AuthService;
  backupService: BackupService;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  getStellaAppDir: () => string | null;
  externalLinkService: ExternalLinkService;
  ensurePrivilegedActionApproval: (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => Promise<boolean>;
  hardResetLocalState: () => Promise<{ ok: true }>;
  resetLocalMessages: () => Promise<{ ok: true }>;
  shutdownRuntime: () => Promise<void>;
  restartRuntime: () => Promise<void>;
  submitCredential: (payload: {
    requestId: string;
    secretId: string;
    provider: string;
    label: string;
  }) => { ok: boolean; error?: string };
  cancelCredential: (payload: { requestId: string }) => {
    ok: boolean;
    error?: string;
  };
  /**
   * Connector credential brokers (`stella-connect` auth dialog). Distinct
   * pair from `submitCredential`/`cancelCredential` because the value is
   * persisted directly to `~/.stella/connectors/.credentials.json` instead of
   * being routed through Convex secrets.
   */
  submitConnectorCredential: (payload: {
    requestId: string;
    value: string;
    label?: string;
  }) =>
    | Promise<{ ok: boolean; error?: string }>
    | { ok: boolean; error?: string };
  cancelConnectorCredential: (payload: { requestId: string }) => {
    ok: boolean;
    error?: string;
  };
  getBroadcastToMobile?: () =>
    | ((channel: string, data: unknown) => void)
    | null;
  startPhoneAccessSession: () => { ok: boolean };
  stopPhoneAccessSession: () => Promise<{ ok: boolean }>;
  onPermissionGranted?: (kind: MacPermissionKind) => void;
  stopGlobalInputHooksForPermissionReset?: () => void;
  /** Update the radial-trigger key on the gesture service when prefs change. */
  setRadialTriggerKey: (triggerKey: RadialTriggerCode) => void;
  /** Update the mini double-tap modifier on the gesture service when prefs change. */
  setMiniDoubleTapModifier: (modifier: MiniDoubleTapModifier) => void;
  /** When Accessibility is granted (e.g. user enabled it in System Settings), ensure hooks are running. */
  ensureRadialGestureOnMac?: () => void;
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const sanitizeStringRecord = (value: unknown): Record<string, string> => {
  const nextRecord: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {},
  )) {
    const trimmedKey = asTrimmedString(key);
    const trimmedValue = asTrimmedString(entryValue);
    if (!trimmedKey || !trimmedValue) {
      continue;
    }
    nextRecord[trimmedKey] = trimmedValue;
  }
  return nextRecord;
};

const sanitizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = asTrimmedString(entry);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const sanitizeReasoningEfforts = (
  value: unknown,
): Record<string, ReasoningEffort> => {
  const nextRecord: Record<string, ReasoningEffort> = {};
  for (const [key, entryValue] of Object.entries(
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {},
  )) {
    const trimmedKey = asTrimmedString(key);
    if (!trimmedKey) continue;
    if (
      entryValue === "minimal" ||
      entryValue === "low" ||
      entryValue === "medium" ||
      entryValue === "high" ||
      entryValue === "xhigh"
    ) {
      nextRecord[trimmedKey] = entryValue;
    }
  }
  return nextRecord;
};

const sanitizeReasoningEffort = (value: unknown): ReasoningEffort => {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return "default";
};

let preventSleepBlockerId: number | null = null;

export const setPreventComputerSleep = (enabled: boolean) => {
  if (enabled) {
    if (
      preventSleepBlockerId === null ||
      !powerSaveBlocker.isStarted(preventSleepBlockerId)
    ) {
      preventSleepBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    }
    return;
  }

  if (preventSleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(preventSleepBlockerId)) {
      powerSaveBlocker.stop(preventSleepBlockerId);
    }
    preventSleepBlockerId = null;
  }
};

type LockedComputerUseStatus = {
  ok: boolean;
  enabled: boolean;
  installed: boolean;
  active: boolean;
  locked: boolean;
  suppressedUntilManualUnlock: boolean;
  message: string;
  warnings: string[];
};

type ProcessCaptureResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: Error;
};

const lockedComputerUseInstallerTimeoutMs = 120_000;

const resolveLockedComputerUseHome = (stellaAppDir: string | null) => {
  if (process.env.STELLA_DATA_DIR) {
    return path.resolve(process.env.STELLA_DATA_DIR);
  }
  if (stellaAppDir) {
    return path.resolve(stellaAppDir);
  }
  return path.join(os.homedir(), ".stella");
};

const readLockedComputerUseEnabled = (stellaAppDir: string | null) => {
  try {
    return loadLocalPreferences(resolveLockedComputerUseHome(stellaAppDir))
      .lockedComputerUseEnabled;
  } catch {
    return false;
  }
};

const writeLockedComputerUseEnabled = (
  stellaAppDir: string | null,
  enabled: boolean,
) => {
  const stellaDataDir = resolveLockedComputerUseHome(stellaAppDir);
  const prefs = loadLocalPreferences(stellaDataDir);
  saveLocalPreferences(stellaDataDir, {
    ...prefs,
    lockedComputerUseEnabled: enabled,
  });
};

const runProcessCapture = async (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessCaptureResult> =>
  await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const settle = (result: ProcessCaptureResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({
        status: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr:
          Buffer.concat(stderrChunks).toString("utf8").trim() ||
          `${command} timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      settle({
        status: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: error.message,
        error,
      });
    });
    child.once("exit", (status) => {
      settle({
        status: status ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
      });
    });
  });

const lockedComputerUseInstallerPaths = () => {
  const installerPath = resolveNativeHelperPath("locked_use_installer");
  if (!installerPath) {
    throw new Error(
      'Native helper "locked_use_installer" was not found. Build desktop/native first.',
    );
  }
  return {
    installerPath,
    resourceDir: path.dirname(installerPath),
  };
};

const lockedComputerUseAuthorizerPath = (resourceDir: string) => {
  const helperPath = path.join(
    resourceDir,
    "Stella.app",
    "Contents",
    "MacOS",
    "Stella",
  );
  if (!existsSync(helperPath)) {
    throw new Error(
      'Native helper "Stella.app" was not found. Build desktop/native first.',
    );
  }
  return helperPath;
};

const runLockedComputerUseInstaller = async (
  action: "install" | "uninstall" | "status",
  options: { admin?: boolean } = {},
) => {
  const { installerPath, resourceDir } = lockedComputerUseInstallerPaths();
  if (
    options.admin &&
    process.platform === "darwin" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0
  ) {
    return await runProcessCapture(
      lockedComputerUseAuthorizerPath(resourceDir),
      [action, resourceDir],
      lockedComputerUseInstallerTimeoutMs,
    );
  }
  return await runProcessCapture(
    installerPath,
    [action, resourceDir],
    lockedComputerUseInstallerTimeoutMs,
  );
};

const getLockedComputerUseStatus = async (
  stellaAppDir: string | null,
): Promise<LockedComputerUseStatus> => {
  if (process.platform !== "darwin") {
    return {
      ok: true,
      enabled: false,
      installed: false,
      active: false,
      locked: false,
      suppressedUntilManualUnlock: false,
      message: "Locked computer use is only available on macOS.",
      warnings: [],
    };
  }

  let installed = false;
  let message = "";
  try {
    const status = await runLockedComputerUseInstaller("status");
    message = [status.stdout, status.stderr].filter(Boolean).join("\n").trim();
    installed =
      /\binstalled\b/.test(message) && !/\bnot-installed\b/.test(message);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: true,
    enabled: readLockedComputerUseEnabled(stellaAppDir),
    installed,
    active: false,
    locked: false,
    suppressedUntilManualUnlock: false,
    message: message || "Locked computer use status unavailable.",
    warnings: [],
  };
};

const createStoppedSocialSessionSnapshot = () => ({
  enabled: false,
  status: "stopped" as const,
  sessionCount: 0,
  sessions: [],
});

const sanitizeOptionalHttpUrl = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid ${fieldName}.`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid ${fieldName}.`);
  }

  return parsed.toString();
};

const asSocialSessionStatus = (value: unknown): RuntimeSocialSessionStatus => {
  if (value === "active" || value === "paused" || value === "ended") {
    return value;
  }
  throw new Error("Invalid social session status.");
};

export const registerSystemHandlers = (options: SystemHandlersOptions) => {
  ipcMain.handle("device:getId", () => options.getDeviceId());

  ipcMain.handle(IPC_APP_QUIT_FOR_RESTART, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_APP_QUIT_FOR_RESTART,
      )
    ) {
      throw new Error("Blocked untrusted app:quitForRestart request.");
    }
    setTimeout(() => {
      app.quit();
    }, 50);
    return { ok: true };
  });

  ipcMain.handle("phoneAccess:startSession", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "phoneAccess:startSession",
      )
    ) {
      throw new Error("Blocked untrusted phoneAccess:startSession request.");
    }
    return options.startPhoneAccessSession();
  });

  ipcMain.handle("phoneAccess:stopSession", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "phoneAccess:stopSession",
      )
    ) {
      throw new Error("Blocked untrusted phoneAccess:stopSession request.");
    }
    return await options.stopPhoneAccessSession();
  });

  ipcMain.handle(
    IPC_SOCIAL_SESSIONS_CREATE,
    async (
      event,
      payload: {
        roomId?: string;
        workspaceLabel?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SOCIAL_SESSIONS_CREATE,
        )
      ) {
        throw new Error("Blocked untrusted socialSessions:create request.");
      }
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.createSocialSession({
        roomId: asTrimmedString(payload?.roomId),
        workspaceLabel: asTrimmedString(payload?.workspaceLabel) || undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
    async (
      event,
      payload: {
        sessionId?: string;
        status?: RuntimeSocialSessionStatus;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
        )
      ) {
        throw new Error(
          "Blocked untrusted socialSessions:updateStatus request.",
        );
      }
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.updateSocialSessionStatus({
        sessionId: asTrimmedString(payload?.sessionId),
        status: asSocialSessionStatus(payload?.status),
      });
    },
  );

  ipcMain.handle(
    IPC_SOCIAL_SESSIONS_QUEUE_TURN,
    async (
      event,
      payload: {
        sessionId?: string;
        prompt?: string;
        agentType?: string;
        clientTurnId?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SOCIAL_SESSIONS_QUEUE_TURN,
        )
      ) {
        throw new Error("Blocked untrusted socialSessions:queueTurn request.");
      }
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.queueSocialSessionTurn({
        sessionId: asTrimmedString(payload?.sessionId),
        prompt: asTrimmedString(payload?.prompt),
        agentType: asTrimmedString(payload?.agentType) || undefined,
        clientTurnId: asTrimmedString(payload?.clientTurnId) || undefined,
      });
    },
  );

  ipcMain.handle(IPC_SOCIAL_SESSIONS_GET_STATUS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_SOCIAL_SESSIONS_GET_STATUS,
      )
    ) {
      throw new Error("Blocked untrusted socialSessions:getStatus request.");
    }
    try {
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.getSocialSessionStatus();
    } catch (error) {
      if (isRuntimeUnavailableError(error)) {
        return createStoppedSocialSessionSnapshot();
      }
      throw error;
    }
  });

  ipcMain.handle(
    "host:configurePiRuntime",
    (event, config: { convexUrl?: string; convexSiteUrl?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "host:configurePiRuntime",
        )
      ) {
        throw new Error("Blocked untrusted host configuration request.");
      }
      const convexUrl = sanitizeOptionalHttpUrl(config?.convexUrl, "convexUrl");
      const convexSiteUrl = sanitizeOptionalHttpUrl(
        config?.convexSiteUrl,
        "convexSiteUrl",
      );
      if (convexUrl) {
        options.authService.configurePiRuntime({
          convexUrl,
          convexSiteUrl,
        });
      }
      return { deviceId: options.getDeviceId() };
    },
  );

  ipcMain.handle(
    "auth:setState",
    (
      event,
      payload: {
        authenticated?: boolean;
        token?: string;
        hasConnectedAccount?: boolean;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "auth:setState",
        )
      ) {
        throw new Error("Blocked untrusted auth:setState request.");
      }
      options.authService.setHostAuthState(
        Boolean(payload?.authenticated),
        payload?.token,
        payload?.hasConnectedAccount,
      );
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_AUTH_GET_SESSION, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "auth:getSession",
      )
    ) {
      throw new Error("Blocked untrusted auth session request.");
    }
    return await options.authService.getBetterAuthSession();
  });

  ipcMain.handle(IPC_AUTH_SIGN_IN_ANONYMOUS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "auth:signInAnonymous",
      )
    ) {
      throw new Error("Blocked untrusted anonymous sign-in request.");
    }
    return await options.authService.signInAnonymous();
  });

  ipcMain.handle(IPC_AUTH_SIGN_OUT, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(event, "auth:signOut")
    ) {
      throw new Error("Blocked untrusted sign-out request.");
    }
    return await options.authService.signOut();
  });

  ipcMain.handle(IPC_AUTH_DELETE_USER, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "auth:deleteUser",
      )
    ) {
      throw new Error("Blocked untrusted account deletion request.");
    }
    return await options.authService.deleteUser();
  });

  ipcMain.handle(
    IPC_AUTH_VERIFY_CALLBACK_URL,
    async (event, payload: { url?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "auth:verifyCallbackUrl",
        )
      ) {
        throw new Error(
          "Blocked untrusted auth callback verification request.",
        );
      }
      return await options.authService.verifyAuthCallbackUrl(
        typeof payload?.url === "string" ? payload.url : "",
      );
    },
  );

  ipcMain.handle(
    IPC_AUTH_APPLY_SESSION_COOKIE,
    (event, payload: { sessionCookie?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "auth:applySessionCookie",
        )
      ) {
        throw new Error("Blocked untrusted session-cookie request.");
      }
      return options.authService.applySessionCookie(
        typeof payload?.sessionCookie === "string" ? payload.sessionCookie : "",
      );
    },
  );

  ipcMain.handle(IPC_AUTH_GET_CONVEX_TOKEN, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "auth:getConvexToken",
      )
    ) {
      throw new Error("Blocked untrusted Convex token request.");
    }
    return await options.authService.getConvexAuthToken();
  });

  // Renderer-pull for the cold-boot deep-link OTT (`stella://auth/callback`).
  // Main captures the URL from argv before any window exists; previously it
  // rebroadcast on `did-finish-load`, but that fires before React's
  // `useEffect`s flush, so the renderer-side `auth:callback` listener was
  // racy. The renderer now pulls explicitly from `AuthDeepLinkHandler` once
  // its subscription is live.
  ipcMain.handle(IPC_AUTH_CONSUME_PENDING_CALLBACK, () => {
    return options.authService.consumePendingAuthCallback();
  });

  ipcMain.handle(
    IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
    (
      event,
      payload: {
        requestId?: string;
        authenticated?: boolean;
        token?: string | null;
        hasConnectedAccount?: boolean;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "auth:runtimeRefreshComplete",
        )
      ) {
        throw new Error(
          "Blocked untrusted auth:runtimeRefreshComplete request.",
        );
      }
      const requestId =
        typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
      if (!requestId) {
        throw new Error("Missing runtime auth refresh request id.");
      }
      return options.authService.completeRuntimeAuthRefresh({
        requestId,
        authenticated: payload?.authenticated,
        token: payload?.token,
        hasConnectedAccount: payload?.hasConnectedAccount,
      });
    },
  );

  ipcMain.handle(
    "host:setCloudSyncEnabled",
    (event, payload: { enabled: boolean }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "host:setCloudSyncEnabled",
        )
      ) {
        throw new Error("Blocked untrusted host:setCloudSyncEnabled request.");
      }
      options
        .getStellaHostRunner()
        ?.setCloudSyncEnabled(Boolean(payload?.enabled));
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT,
    (event, payload: { updatedAt?: number | null }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT,
        )
      ) {
        throw new Error(
          "Blocked untrusted host:setModelCatalogUpdatedAt request.",
        );
      }
      const updatedAt =
        typeof payload?.updatedAt === "number" &&
        Number.isFinite(payload.updatedAt)
          ? payload.updatedAt
          : null;
      options.getStellaHostRunner()?.setModelCatalogUpdatedAt(updatedAt);
      return { ok: true };
    },
  );

  ipcMain.handle("app:hardResetLocalState", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "app:hardResetLocalState",
      )
    ) {
      throw new Error("Blocked untrusted app:hardResetLocalState request.");
    }
    return options.hardResetLocalState();
  });

  ipcMain.handle("app:resetLocalMessages", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "app:resetLocalMessages",
      )
    ) {
      throw new Error("Blocked untrusted app:resetLocalMessages request.");
    }
    return options.resetLocalMessages();
  });

  ipcMain.handle(
    "credential:submit",
    (
      event,
      payload: {
        requestId: string;
        secretId: string;
        provider: string;
        label: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "credential:submit",
        )
      ) {
        throw new Error("Blocked untrusted credential submission.");
      }
      return options.submitCredential(payload);
    },
  );

  ipcMain.handle(
    "credential:cancel",
    (event, payload: { requestId: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "credential:cancel",
        )
      ) {
        throw new Error("Blocked untrusted credential cancellation.");
      }
      return options.cancelCredential(payload);
    },
  );

  ipcMain.handle(
    "connector-credential:submit",
    async (
      event,
      payload: { requestId: string; value: string; label?: string },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "connector-credential:submit",
        )
      ) {
        throw new Error("Blocked untrusted connector credential submission.");
      }
      return await options.submitConnectorCredential(payload);
    },
  );

  ipcMain.handle(
    "connector-credential:cancel",
    (event, payload: { requestId: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "connector-credential:cancel",
        )
      ) {
        throw new Error("Blocked untrusted connector credential cancellation.");
      }
      return options.cancelConnectorCredential(payload);
    },
  );

  ipcMain.on("shell:openExternal", (event, url: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "shell:openExternal",
      )
    ) {
      console.debug("[system] blocked untrusted shell:openExternal");
      return;
    }
    const safeUrl = options.externalLinkService.normalizeExternalHttpUrl(url);
    if (!safeUrl) {
      console.debug("[system] rejected invalid URL for shell:openExternal");
      return;
    }
    if (
      !options.externalLinkService.consumeExternalOpenBudget(event.sender.id)
    ) {
      console.debug("[system] shell:openExternal rate limited");
      return;
    }
    void shell.openExternal(safeUrl);
  });

  ipcMain.on("shell:showItemInFolder", (event, filePath: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "shell:showItemInFolder",
      )
    ) {
      return;
    }
    if (typeof filePath === "string" && filePath.trim()) {
      shell.showItemInFolder(filePath.trim());
    }
  });

  ipcMain.on(
    IPC_DIAGNOSTICS_REPORT_ERROR,
    (
      event,
      payload: {
        message?: string;
        stack?: string;
        source?: string;
        kind?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_DIAGNOSTICS_REPORT_ERROR,
        )
      ) {
        return;
      }
      // The shared FileLogger scrubs message/stack before writing. `stack`
      // is rendered as an indented block; pass the renderer's stack through
      // directly rather than via crash() (which would wrap the string and
      // overwrite it with a main-process stack).
      getMainLogger()?.error("renderer.error", {
        kind: payload?.kind,
        source: payload?.source,
        errorMessage: payload?.message,
        ...(payload?.stack ? { stack: payload.stack } : {}),
      });
    },
  );

  ipcMain.handle(IPC_DIAGNOSTICS_OPEN_LOGS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_DIAGNOSTICS_OPEN_LOGS,
      )
    ) {
      throw new Error("Blocked untrusted diagnostics:openLogs request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return { ok: false as const, error: "no-root" };
    const { logDir } = resolveLogPaths(stellaAppDir);
    const opened = await shell.openPath(logDir);
    // shell.openPath returns "" on success, or an error string.
    return opened
      ? { ok: false as const, error: opened, path: logDir }
      : { ok: true as const, path: logDir };
  });

  ipcMain.handle(
    IPC_SHELL_SAVE_FILE_AS,
    async (
      event,
      payload: { sourcePath: string; defaultName?: string },
    ): Promise<{
      ok: boolean;
      path?: string;
      canceled?: boolean;
      error?: string;
    }> => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SHELL_SAVE_FILE_AS,
        )
      ) {
        return { ok: false, error: "Blocked untrusted request." };
      }

      const sourcePath =
        typeof payload?.sourcePath === "string"
          ? payload.sourcePath.trim()
          : "";
      if (!sourcePath) {
        return { ok: false, error: "Missing source file." };
      }

      try {
        const sourceStat = await stat(sourcePath);
        if (!sourceStat.isFile()) {
          return { ok: false, error: "Only files can be saved." };
        }

        const defaultName =
          typeof payload.defaultName === "string" && payload.defaultName.trim()
            ? path.basename(payload.defaultName.trim())
            : path.basename(sourcePath);
        const owner = BrowserWindow.fromWebContents(event.sender);
        const saveOptions = {
          defaultPath: defaultName,
        };
        const result = owner
          ? await dialog.showSaveDialog(owner, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (result.canceled || !result.filePath) {
          return { ok: false, canceled: true };
        }

        await copyFile(sourcePath, result.filePath);
        return { ok: true, path: result.filePath };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.on(IPC_SYSTEM_OPEN_FDA, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_SYSTEM_OPEN_FDA,
      )
    ) {
      return;
    }
    const approved = await options.ensurePrivilegedActionApproval(
      "system.open_full_disk_access",
      "Allow Stella to open Full Disk Access settings?",
      "This opens macOS System Settings so Stella can be granted disk access for user-requested tasks.",
      event,
    );
    if (!approved) {
      return;
    }
    if (process.platform === "darwin") {
      // Register the Stella.app bundle with TCC first so it shows up in the
      // Full Disk Access list, then open the pane for the user to toggle on.
      await registerStellaForFullDiskAccess();
      await openMacPermissionSettings("full-disk-access");
    }
  });

  ipcMain.handle(
    "shell:killByPort",
    async (event, payload: { port: number }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "shell:killByPort",
        )
      ) {
        throw new Error("Blocked untrusted shell kill request.");
      }
      const port = Number(payload?.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Invalid port.");
      }
      options.getStellaHostRunner()?.killShellsByPort(port);
    },
  );

  ipcMain.handle(IPC_BACKUP_GET_STATUS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_BACKUP_GET_STATUS,
      )
    ) {
      throw new Error("Blocked untrusted backup:getStatus request.");
    }
    return await options.backupService.getStatus();
  });

  ipcMain.handle(IPC_BACKUP_RUN_NOW, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_BACKUP_RUN_NOW,
      )
    ) {
      throw new Error("Blocked untrusted backup:runNow request.");
    }
    return await options.backupService.backupNow();
  });

  ipcMain.handle(
    IPC_BACKUP_LIST,
    async (event, payload: { limit?: number } | undefined) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_BACKUP_LIST,
        )
      ) {
        throw new Error("Blocked untrusted backup:list request.");
      }
      const rawLimit = Number(payload?.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(50, Math.floor(rawLimit))
          : 25;
      return await options.backupService.listBackups(limit);
    },
  );

  ipcMain.handle(
    IPC_BACKUP_RESTORE,
    async (event, payload: { snapshotId?: string } | undefined) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_BACKUP_RESTORE,
        )
      ) {
        throw new Error("Blocked untrusted backup:restore request.");
      }
      const snapshotId = asTrimmedString(payload?.snapshotId);
      if (!snapshotId) {
        throw new Error("Missing backup snapshot ID.");
      }
      const approved = await options.ensurePrivilegedActionApproval(
        "backup.restore_remote",
        "Restore this backup and restart Stella?",
        "This replaces your current local Stella files with the selected backup, preserves this device's identity and local credentials, and then restarts the app.",
        event,
      );
      if (!approved) {
        throw new Error("Backup restore was cancelled.");
      }
      const result = await options.backupService.restoreBackup(snapshotId, {
        shutdownRuntime: options.shutdownRuntime,
        restartRuntime: options.restartRuntime,
      });
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 500);
      return result;
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_SYNC_MODE, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_SYNC_MODE,
      )
    ) {
      throw new Error("Blocked untrusted preferences:getSyncMode request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return "off";
    return getSyncMode(stellaAppDir);
  });

  ipcMain.handle(IPC_PREFERENCES_SET_SYNC_MODE, (event, mode: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_SET_SYNC_MODE,
      )
    ) {
      throw new Error("Blocked untrusted preferences:setSyncMode request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return;
    const prefs = loadLocalPreferences(stellaAppDir);
    prefs.syncMode = mode === "off" ? "off" : "on";
    saveLocalPreferences(stellaAppDir, prefs);
    return options.backupService.setMode(prefs.syncMode);
  });

  ipcMain.handle(IPC_PREFERENCES_GET_RADIAL_TRIGGER, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_RADIAL_TRIGGER,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getRadialTrigger request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return DEFAULT_RADIAL_TRIGGER_CODE;
    return loadLocalPreferences(stellaAppDir).radialTriggerKey;
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_RADIAL_TRIGGER,
    (event, triggerKey: string) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_RADIAL_TRIGGER,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setRadialTrigger request.",
        );
      }
      const nextTriggerKey = normalizeRadialTriggerCode(triggerKey);
      const stellaAppDir = options.getStellaAppDir();
      if (stellaAppDir) {
        const prefs = loadLocalPreferences(stellaAppDir);
        prefs.radialTriggerKey = nextTriggerKey;
        saveLocalPreferences(stellaAppDir, prefs);
      }
      options.setRadialTriggerKey(nextTriggerKey);
      return { triggerKey: nextTriggerKey };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_MINI_DOUBLE_TAP, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_MINI_DOUBLE_TAP,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getMiniDoubleTap request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return "Alt";
    return loadLocalPreferences(stellaAppDir).miniDoubleTapModifier;
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_MINI_DOUBLE_TAP,
    (event, modifier: string) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_MINI_DOUBLE_TAP,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setMiniDoubleTap request.",
        );
      }
      const nextModifier = normalizeMiniDoubleTapModifier(modifier);
      const stellaAppDir = options.getStellaAppDir();
      if (stellaAppDir) {
        const prefs = loadLocalPreferences(stellaAppDir);
        prefs.miniDoubleTapModifier = nextModifier;
        saveLocalPreferences(stellaAppDir, prefs);
      }
      options.setMiniDoubleTapModifier(nextModifier);
      return { modifier: nextModifier };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_PREVENT_SLEEP, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_PREVENT_SLEEP,
      )
    ) {
      throw new Error("Blocked untrusted preferences:getPreventSleep request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return false;
    return getPreventComputerSleep(stellaAppDir);
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_PREVENT_SLEEP,
    (event, enabled: boolean) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_PREVENT_SLEEP,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setPreventSleep request.",
        );
      }
      const nextEnabled = enabled === true;
      const stellaAppDir = options.getStellaAppDir();
      if (stellaAppDir) {
        const prefs = loadLocalPreferences(stellaAppDir);
        prefs.preventComputerSleep = nextEnabled;
        saveLocalPreferences(stellaAppDir, prefs);
      }
      setPreventComputerSleep(nextEnabled);
      return { enabled: nextEnabled };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getLockedComputerUse request.",
      );
    }
    return await getLockedComputerUseStatus(options.getStellaAppDir());
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
    async (event, enabled: boolean) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setLockedComputerUse request.",
        );
      }
      if (process.platform !== "darwin") {
        throw new Error("Locked computer use is only available on macOS.");
      }

      const nextEnabled = enabled === true;
      const stellaAppDir = options.getStellaAppDir();
      const currentStatus = await getLockedComputerUseStatus(stellaAppDir);
      if (!nextEnabled) {
        writeLockedComputerUseEnabled(stellaAppDir, false);
        return {
          ...currentStatus,
          enabled: false,
        };
      }
      if (nextEnabled && currentStatus.installed) {
        writeLockedComputerUseEnabled(stellaAppDir, true);
        return {
          ...currentStatus,
          enabled: true,
        };
      }

      const installerResult = await runLockedComputerUseInstaller("install", {
        admin: true,
      });
      if (installerResult.status !== 0) {
        throw new Error(
          installerResult.stderr ||
            installerResult.stdout ||
            "Failed to enable locked computer use.",
        );
      }

      const status = await getLockedComputerUseStatus(stellaAppDir);
      if (!status.installed) {
        throw new Error(
          installerResult.stderr ||
            installerResult.stdout ||
            "Locked computer use install did not complete.",
        );
      }
      writeLockedComputerUseEnabled(stellaAppDir, nextEnabled);
      return {
        ...status,
        enabled: true,
        message:
          installerResult.stdout ||
          installerResult.stderr ||
          status.message ||
          "OK",
      };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getSoundNotifications request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return true;
    return getSoundNotificationsEnabled(stellaAppDir);
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
    (event, enabled: boolean) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setSoundNotifications request.",
        );
      }
      const nextEnabled = enabled === true;
      const stellaAppDir = options.getStellaAppDir();
      if (stellaAppDir) {
        const prefs = loadLocalPreferences(stellaAppDir);
        prefs.soundNotificationsEnabled = nextEnabled;
        saveLocalPreferences(stellaAppDir, prefs);
      }
      return { enabled: nextEnabled };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_READ_ALOUD, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_READ_ALOUD,
      )
    ) {
      throw new Error("Blocked untrusted preferences:getReadAloud request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return false;
    return getReadAloudEnabled(stellaAppDir);
  });

  ipcMain.handle(IPC_PREFERENCES_GET_ONBOARDING_COMPLETED, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getOnboardingCompleted request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return false;
    return getOnboardingCompleted(stellaAppDir);
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
    (event, completed: boolean) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setOnboardingCompleted request.",
        );
      }
      const nextCompleted = completed === true;
      const stellaAppDir = options.getStellaAppDir();
      if (stellaAppDir) {
        setOnboardingCompleted(stellaAppDir, nextCompleted);
      }
      return { completed: nextCompleted };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_SET_READ_ALOUD, (event, enabled: boolean) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_SET_READ_ALOUD,
      )
    ) {
      throw new Error("Blocked untrusted preferences:setReadAloud request.");
    }
    const nextEnabled = enabled === true;
    const stellaAppDir = options.getStellaAppDir();
    if (stellaAppDir) {
      setReadAloudEnabled(stellaAppDir, nextEnabled);
    }
    return { enabled: nextEnabled };
  });

  ipcMain.handle(IPC_PREFERENCES_GET_CADENCE_REPORTS, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_CADENCE_REPORTS,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getCadenceReports request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) {
      return {
        schedules: { "4h": false, daily: false, weekly: false },
        browser: null,
        profile: null,
      } satisfies CadenceReportsPreferences;
    }
    return getCadenceReportsPreferences(stellaAppDir);
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_CADENCE_REPORTS,
    (event, settings: CadenceReportsPreferences) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_CADENCE_REPORTS,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setCadenceReports request.",
        );
      }
      const fallback: CadenceReportsPreferences = {
        schedules: { "4h": false, daily: false, weekly: false },
        browser: null,
        profile: null,
      };
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) return fallback;
      return setCadenceReportsPreferences(stellaAppDir, settings ?? fallback);
    },
  );

  ipcMain.handle(IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
      )
    ) {
      throw new Error(
        "Blocked untrusted globalShortcuts:getSuspended request.",
      );
    }
    return getGlobalShortcutsSuspended();
  });

  ipcMain.handle(
    IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
    (event, suspended: boolean) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
        )
      ) {
        throw new Error(
          "Blocked untrusted globalShortcuts:setSuspended request.",
        );
      }
      return setGlobalShortcutsSuspended(suspended === true);
    },
  );

  ipcMain.handle(
    IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
    async (event, payload?: { durationMs?: number }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
        )
      ) {
        throw new Error(
          "Blocked untrusted diagnostics:recordHeapTrace request.",
        );
      }
      const durationMs = clampHeapTraceDurationMs(payload?.durationMs);
      try {
        await contentTracing.enableHeapProfiling?.();
        await contentTracing.startRecording({
          included_categories: ["disabled-by-default-memory-infra"],
          excluded_categories: ["*"],
          memory_dump_config: {
            triggers: [{ mode: "detailed", periodic_interval_ms: 1000 }],
          },
        });
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        const tracePath = await contentTracing.stopRecording();
        return { ok: true, path: tracePath };
      } catch (error) {
        try {
          await contentTracing.stopRecording();
        } catch {
          // No active trace, or tracing already stopped.
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_PERSONALITY_VOICE, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_PERSONALITY_VOICE,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getPersonalityVoice request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) return null;
    return getPersonalityVoiceId(stellaAppDir) ?? null;
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_PERSONALITY_VOICE,
    (event, voiceId: unknown) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_PERSONALITY_VOICE,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setPersonalityVoice request.",
        );
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) return { ok: false, voiceId: "" };
      if (!isKnownPersonalityId(voiceId)) {
        throw new Error("Unknown personality preset id.");
      }
      const normalized = coercePersonalityId(voiceId);
      setPersonalityVoiceId(stellaAppDir, normalized);
      try {
        writePersonality(stellaAppDir, normalized);
      } catch {
        // Best-effort — the seed pass on the next orchestrator turn will
        // re-compose from the preference if the file is missing.
      }
      return { ok: true, voiceId: normalized };
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_MODELS, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_MODELS,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:getLocalModelPreferences request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) {
      return null;
    }
    return getLocalModelPreferences(stellaAppDir);
  });

  ipcMain.handle(IPC_PREFERENCES_LIST_CODEX_MODELS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_LIST_CODEX_MODELS,
      )
    ) {
      throw new Error("Blocked untrusted preferences:listCodexModels request.");
    }
    return listCodexAppServerModels();
  });

  ipcMain.handle(IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
      )
    ) {
      throw new Error(
        "Blocked untrusted preferences:listClaudeCodeModels request.",
      );
    }
    const stellaAppDir = options.getStellaAppDir();
    const apiKey = stellaAppDir
      ? getLocalLlmCredential(stellaAppDir, "anthropic")
      : null;
    const oauthToken = stellaAppDir
      ? await getLocalLlmOAuthApiKey(stellaAppDir, "anthropic")
      : null;
    return listClaudeCodeModels({ apiKey, oauthToken });
  });

  ipcMain.handle(
    IPC_PREFERENCES_SET_MODELS,
    (event, payload: Partial<LocalModelPreferencesSnapshot>) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SET_MODELS,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:setLocalModelPreferences request.",
        );
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) return null;

      const nextDefaultModels = sanitizeStringRecord(payload?.defaultModels);
      const nextOverrides = sanitizeStringRecord(payload?.modelOverrides);
      const nextAssistantPropagatedAgents = sanitizeStringList(
        payload?.assistantPropagatedAgents,
      );
      const nextReasoningEfforts = sanitizeReasoningEfforts(
        payload?.reasoningEfforts,
      );

      const agentRuntimeEngine = coerceAgentRuntimeEngine(
        payload?.agentRuntimeEngine,
      );
      const parsedConcurrency = Number(payload?.maxAgentConcurrency);
      const maxAgentConcurrency =
        Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
          ? Math.min(24, Math.floor(parsedConcurrency))
          : 24;

      const patch: Partial<LocalModelPreferencesSnapshot> = {};
      if (payload?.defaultModels !== undefined) {
        patch.defaultModels = nextDefaultModels;
      }
      if (payload?.modelOverrides !== undefined) {
        patch.modelOverrides = nextOverrides;
      }
      if (payload?.assistantPropagatedAgents !== undefined) {
        patch.assistantPropagatedAgents = nextAssistantPropagatedAgents;
      }
      if (payload?.reasoningEfforts !== undefined) {
        patch.reasoningEfforts = nextReasoningEfforts;
      }
      if (payload?.agentRuntimeEngine !== undefined) {
        patch.agentRuntimeEngine = agentRuntimeEngine;
      }
      if (payload?.codexModel !== undefined) {
        patch.codexModel =
          typeof payload.codexModel === "string"
            ? payload.codexModel.trim()
            : "";
      }
      if (payload?.codexReasoningEffort !== undefined) {
        patch.codexReasoningEffort = sanitizeReasoningEffort(
          payload.codexReasoningEffort,
        );
      }
      if (payload?.claudeCodeModel !== undefined) {
        patch.claudeCodeModel =
          typeof payload.claudeCodeModel === "string"
            ? payload.claudeCodeModel.trim()
            : "";
      }
      if (payload?.claudeCodeReasoningEffort !== undefined) {
        patch.claudeCodeReasoningEffort = sanitizeReasoningEffort(
          payload.claudeCodeReasoningEffort,
        );
      }
      if (payload?.maxAgentConcurrency !== undefined) {
        patch.maxAgentConcurrency = maxAgentConcurrency;
      }
      if (payload?.imageGeneration !== undefined) {
        patch.imageGeneration = normalizeImageGenerationPreferences(
          payload.imageGeneration,
        );
      }
      if (payload?.realtimeVoice !== undefined) {
        patch.realtimeVoice = normalizeRealtimeVoicePreferences(
          payload.realtimeVoice,
        );
      }
      return updateLocalModelPreferences(stellaAppDir, patch);
    },
  );

  ipcMain.handle("llmCredentials:list", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "llmCredentials:list",
      )
    ) {
      throw new Error("Blocked untrusted credential request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) {
      return [];
    }
    return listLocalLlmCredentials(stellaAppDir);
  });

  ipcMain.handle("llmCredentials:listOAuthProviders", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "llmCredentials:listOAuthProviders",
      )
    ) {
      throw new Error("Blocked untrusted OAuth provider request.");
    }
    return getOAuthProviders().map((provider) => ({
      provider: provider.id,
      label: provider.name,
    }));
  });

  ipcMain.handle("llmCredentials:listOAuth", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "llmCredentials:listOAuth",
      )
    ) {
      throw new Error("Blocked untrusted OAuth credential request.");
    }
    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) {
      return [];
    }
    return listLocalLlmOAuthCredentials(stellaAppDir);
  });

  ipcMain.handle(
    "llmCredentials:loginOAuth",
    async (event, payload: { provider?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "llmCredentials:loginOAuth",
        )
      ) {
        throw new Error("Blocked untrusted OAuth login request.");
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        throw new Error("Local Stella root is unavailable.");
      }

      const providerId = asTrimmedString(payload?.provider).toLowerCase();
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        throw new Error("Unsupported OAuth provider.");
      }

      const credentials = await provider.login({
        onAuth: (info) => {
          void shell.openExternal(info.url);
        },
        onPrompt: async (prompt) => {
          if (prompt.allowEmpty) return "";
          const result = await dialog.showMessageBox({
            type: "info",
            message: prompt.message,
            detail: prompt.placeholder
              ? `Expected value: ${prompt.placeholder}`
              : undefined,
            buttons: ["Continue"],
          });
          return result.response === 0 ? "" : "";
        },
      });

      return saveLocalLlmOAuthCredential(stellaAppDir, {
        provider: provider.id,
        label: provider.name,
        credentials,
      });
    },
  );

  ipcMain.handle(
    "llmCredentials:deleteOAuth",
    (event, payload: { provider?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "llmCredentials:deleteOAuth",
        )
      ) {
        throw new Error("Blocked untrusted OAuth credential delete.");
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        return { removed: false };
      }
      return deleteLocalLlmOAuthCredential(
        stellaAppDir,
        asTrimmedString(payload?.provider),
      );
    },
  );

  ipcMain.handle(
    "llmCredentials:save",
    (
      event,
      payload: {
        provider?: string;
        label?: string;
        plaintext?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "llmCredentials:save",
        )
      ) {
        throw new Error("Blocked untrusted credential write.");
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        throw new Error("Local Stella root is unavailable.");
      }
      return saveLocalLlmCredential(stellaAppDir, {
        provider: asTrimmedString(payload?.provider),
        label: asTrimmedString(payload?.label),
        plaintext: asTrimmedString(payload?.plaintext),
      });
    },
  );

  ipcMain.handle(
    "llmCredentials:delete",
    (event, payload: { provider?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "llmCredentials:delete",
        )
      ) {
        throw new Error("Blocked untrusted credential delete.");
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        return { removed: false };
      }
      return deleteLocalLlmCredential(
        stellaAppDir,
        asTrimmedString(payload?.provider),
      );
    },
  );

  let lastAccessibilityStatus = false;

  ipcMain.handle(IPC_PERMISSIONS_GET_STATUS, () => {
    const microphoneStatus = getMicrophonePermissionStatus();
    const microphoneGranted = microphoneStatus === "granted";

    if (process.platform !== "darwin") {
      return {
        accessibility: true,
        screen: true,
        microphone: microphoneGranted,
        microphoneStatus,
      };
    }
    const accessibility = hasMacPermission("accessibility", false);
    if (accessibility && !lastAccessibilityStatus) {
      options.onPermissionGranted?.("accessibility");
      try {
        options.ensureRadialGestureOnMac?.();
      } catch {
        // Best-effort; hooks may still be starting.
      }
    }
    lastAccessibilityStatus = accessibility;
    return {
      accessibility,
      screen: hasMacPermission("screen", false),
      microphone: microphoneGranted,
      microphoneStatus,
    };
  });

  ipcMain.handle(IPC_PERMISSIONS_RESET_MICROPHONE, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PERMISSIONS_RESET_MICROPHONE,
      )
    ) {
      throw new Error("Blocked untrusted permissions:resetMicrophone request.");
    }

    if (process.platform !== "darwin") {
      return { ok: false };
    }

    return { ok: await resetMacMicrophonePermissions() };
  });

  ipcMain.handle(
    IPC_PERMISSIONS_RESET,
    async (event, payload: { kind?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PERMISSIONS_RESET,
        )
      ) {
        throw new Error("Blocked untrusted permissions:reset request.");
      }
      if (process.platform !== "darwin") {
        return { ok: false };
      }
      const kind = asTrimmedString(
        payload?.kind,
      ) as ResettableMacPermissionKind;
      if (!["accessibility", "screen", "microphone"].includes(kind)) {
        return { ok: false };
      }
      if (kind !== "accessibility") {
        const approved = await options.ensurePrivilegedActionApproval(
          "permissions.reset",
          `Reset ${kind} permission for Stella?`,
          "Stella will need to ask for this permission again the next time you use a feature that requires it.",
          event,
        );
        if (!approved) {
          return { ok: false };
        }
      }
      if (kind === "accessibility") {
        options.stopGlobalInputHooksForPermissionReset?.();
      }
      const ok = await resetMacPermission(kind);
      if (ok && kind === "accessibility") {
        setTimeout(() => {
          app.quit();
        }, 50);
      }
      return { ok };
    },
  );

  ipcMain.handle(
    IPC_PERMISSIONS_OPEN_SETTINGS,
    async (event, payload: { kind: string }) => {
      const kind = asTrimmedString(payload?.kind) as MacPermissionSettingsKind;
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PERMISSIONS_OPEN_SETTINGS,
        )
      ) {
        throw new Error("Blocked untrusted permissions:openSettings request.");
      }

      if (kind === "microphone" && process.platform === "win32") {
        await shell.openExternal("ms-settings:privacy-microphone");
        return;
      }

      if (process.platform !== "darwin") {
        return;
      }

      await openMacPermissionSettings(kind);
    },
  );

  ipcMain.handle(
    IPC_PERMISSIONS_REQUEST,
    async (event, payload: { kind: string }) => {
      const kind = asTrimmedString(payload?.kind);
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PERMISSIONS_REQUEST,
        )
      ) {
        throw new Error("Blocked untrusted permissions:request request.");
      }

      if (kind === "microphone") {
        return { granted: true, alreadyGranted: true };
      }

      if (process.platform !== "darwin") {
        return { granted: true, alreadyGranted: true };
      }

      const macKind = kind as MacPermissionKind;
      if (!["accessibility", "screen"].includes(macKind)) {
        return { granted: false, alreadyGranted: false };
      }

      clearPermissionCache();
      const result = await requestMacPermission(macKind);
      clearPermissionCache();
      let openedSettings = false;
      if (macKind === "screen" && !result.granted) {
        try {
          const scp = getScreenCapturePermissions();
          if (screenCapturePermissionsHasPrompted(scp)) {
            const openedViaModule =
              await openScreenCaptureSystemPreferences(scp);
            if (openedViaModule) {
              openedSettings = true;
            } else {
              const fallback = await openMacPermissionSettings("screen");
              openedSettings = fallback.opened;
            }
          } else {
            const fallback = await openMacPermissionSettings("screen");
            openedSettings = fallback.opened;
          }
        } catch {
          // Best effort only; the renderer can still expose manual settings access.
        }
      }
      if (result.granted && !result.alreadyGranted) {
        options.onPermissionGranted?.(macKind);
      }
      return { ...result, openedSettings };
    },
  );

  ipcMain.handle("system:detectTechnicalUserSignals", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "system:detectTechnicalUserSignals",
      )
    ) {
      throw new Error(
        "Blocked untrusted system:detectTechnicalUserSignals request.",
      );
    }
    return { signals: await detectTechnicalUserSignalsMemoized() };
  });
};
