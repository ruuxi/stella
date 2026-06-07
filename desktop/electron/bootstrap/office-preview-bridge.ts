import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { watch as watchFs, type FSWatcher } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  OfficePreviewFormat,
  OfficePreviewSnapshot,
  OfficePreviewStatus,
} from "../../../runtime/contracts/office-preview.js";
import { IPC_OFFICE_PREVIEW_UPDATE } from "../../src/shared/contracts/ipc-channels.js";
import { broadcastToWindows, type BootstrapContext } from "./context.js";

type OfficePreviewManifest = {
  sessionId?: unknown;
  title?: unknown;
  sourcePath?: unknown;
  format?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  error?: unknown;
};

const PREVIEW_ROOT_DIRNAME = "office-previews";
const SESSION_MANIFEST_NAME = "session.json";
const SESSION_HTML_NAME = "preview.html";
// Active cadence used only while at least one preview session exists. When there
// are no sessions we fall back to IDLE_POLL_INTERVAL_MS so the bridge is not
// doing a readdir every second for the entire app lifetime (the common case is
// zero preview sessions). Both cadences run the same scan; only the spacing
// differs, so live-update latency is unchanged whenever a session is present.
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 5_000;
const execFileAsync = promisify(execFile);

const isPreviewStatus = (value: unknown): value is OfficePreviewStatus =>
  value === "starting" ||
  value === "ready" ||
  value === "error" ||
  value === "stopped";

const isPreviewFormat = (value: unknown): value is OfficePreviewFormat =>
  value === "docx" || value === "xlsx" || value === "pptx" || value === null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const resolvePreviewRoot = (stellaDataDir: string) =>
  path.join(stellaDataDir, PREVIEW_ROOT_DIRNAME);

const readSnapshotFromSessionDir = async (
  sessionDir: string,
): Promise<OfficePreviewSnapshot | null> => {
  try {
    const manifestPath = path.join(sessionDir, SESSION_MANIFEST_NAME);
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw) as OfficePreviewManifest;
    const sessionId = asString(manifest.sessionId);
    const title = asString(manifest.title);
    const sourcePath = asString(manifest.sourcePath);

    if (!sessionId || !title || !sourcePath) {
      return null;
    }

    let html = "";
    try {
      html = await fs.readFile(
        path.join(sessionDir, SESSION_HTML_NAME),
        "utf-8",
      );
    } catch {
      html = "";
    }

    return {
      sessionId,
      title,
      sourcePath,
      format: isPreviewFormat(manifest.format) ? manifest.format : null,
      startedAt: asNumber(manifest.startedAt, Date.now()),
      updatedAt: asNumber(manifest.updatedAt, Date.now()),
      status: isPreviewStatus(manifest.status) ? manifest.status : "starting",
      html,
      ...(typeof manifest.error === "string" && manifest.error.trim()
        ? { error: manifest.error }
        : {}),
    };
  } catch {
    return null;
  }
};

export const listOfficePreviewSnapshots = async (
  stellaDataDir: string,
): Promise<OfficePreviewSnapshot[]> => {
  const previewRoot = resolvePreviewRoot(stellaDataDir);

  // No per-call mkdir: the bridge ensures the root once at start. If it does
  // not exist yet, treat it as "no sessions" rather than recreating it on
  // every poll tick (a redundant syscall every second for the app lifetime).
  const entries = await fs
    .readdir(previewRoot, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  if (entries === null) {
    return [];
  }
  const snapshots = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readSnapshotFromSessionDir(path.join(previewRoot, entry.name)),
      ),
  );

  return snapshots
    .filter((snapshot): snapshot is OfficePreviewSnapshot => snapshot !== null)
    .sort((left, right) => left.updatedAt - right.updatedAt);
};

const waitForProcessExit = async (pid: number, timeoutMs = 2_500) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
};

const stopPreviewProcess = async (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    await waitForProcessExit(pid);

    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Best-effort preview cleanup.
  }
};

const findPreviewProcessIds = async (sessionId: string): Promise<number[]> => {
  if (!sessionId.trim()) {
    return [];
  }

  if (process.platform === "win32") {
    const escapedSessionId = sessionId.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$session = '${escapedSessionId}'`,
      "$currentPid = $PID",
      "$processes = Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%__run-preview-session%'\"",
      "$matches = @()",
      "foreach ($proc in $processes) {",
      "  $line = [string]$proc.CommandLine",
      "  if (-not $line -or [int]$proc.ProcessId -eq $currentPid) { continue }",
      "  if ($line.Contains('__run-preview-session') -and $line.Contains('--session') -and $line.Contains($session)) {",
      "    $matches += [int]$proc.ProcessId",
      "  }",
      "}",
      "$matches | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      const raw = stdout.trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values
        .map((value) =>
          typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseInt(value, 10)
              : Number.NaN,
        )
        .filter(
          (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
        );
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "pgrep",
      ["-f", `__run-preview-session.*--session ${sessionId}`],
      { windowsHide: true },
    );
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
};

export const stopOfficePreviewSessions = async (stellaDataDir: string) => {
  const snapshots = await listOfficePreviewSnapshots(stellaDataDir).catch(
    () => [],
  );
  const activeSnapshots = snapshots.filter(
    (snapshot) => snapshot.status === "starting" || snapshot.status === "ready",
  );
  const pidGroups = await Promise.all(
    activeSnapshots.map((snapshot) =>
      findPreviewProcessIds(snapshot.sessionId),
    ),
  );
  const pids = [...new Set(pidGroups.flat())];
  await Promise.allSettled(pids.map(stopPreviewProcess));
};

export const startOfficePreviewBridge = (
  context: BootstrapContext,
): (() => void) => {
  const stellaDataDir = context.state.stellaDataDirPath;
  if (!stellaDataDir) {
    return () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Tracks which cadence the current timer runs at so we only re-arm it when the
  // active/idle state actually flips, not on every scan.
  let currentIntervalMs = 0;
  const lastDeliveredAt = new Map<string, number>();
  const previewRoot = resolvePreviewRoot(stellaDataDir);
  let watcher: FSWatcher | null = null;
  let watchKickTimer: ReturnType<typeof setTimeout> | null = null;

  // Create the preview root once up front so the per-tick scan never has to,
  // then watch it so a NEW session appearing while idle triggers an immediate
  // scan instead of waiting up to IDLE_POLL_INTERVAL_MS for the next heartbeat
  // (the first preview from idle would otherwise take up to ~5s to show). The
  // idle poll remains the safety net for platforms/filesystems where fs.watch
  // misses events.
  void fs
    .mkdir(previewRoot, { recursive: true })
    .catch(() => undefined)
    .then(() => {
      if (!stopped) startWatcher();
    });

  // Coalesce bursts of fs events into a single scan shortly after.
  const kickScanSoon = () => {
    if (stopped || watchKickTimer) return;
    watchKickTimer = setTimeout(() => {
      watchKickTimer = null;
      void scan();
    }, 50);
  };

  const startWatcher = () => {
    try {
      // Non-recursive watch of the root: fires when a session dir is
      // created/removed, which is exactly the idle -> first-session transition.
      // Once a session exists the scan upgrades to the 1s active cadence, so
      // in-session updates don't depend on the watcher. `persistent: false`
      // keeps it from holding the process open (like unref).
      watcher = watchFs(previewRoot, { persistent: false }, () => {
        kickScanSoon();
      });
      watcher.on("error", () => {
        // Best-effort: the idle poll remains the safety net.
        watcher?.close();
        watcher = null;
      });
    } catch {
      // Root may not exist yet / platform quirk — poll remains the safety net.
    }
  };

  const arm = (intervalMs: number) => {
    if (stopped || intervalMs === currentIntervalMs) {
      return;
    }
    currentIntervalMs = intervalMs;
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      void scan();
    }, intervalMs);
  };

  const scan = async () => {
    try {
      const snapshots = await listOfficePreviewSnapshots(stellaDataDir);
      if (stopped) {
        return;
      }

      // Prune delivery bookkeeping for sessions that no longer exist so the map
      // does not grow unbounded over the app lifetime.
      if (lastDeliveredAt.size > 0) {
        const present = new Set(
          snapshots.map((snapshot) => snapshot.sessionId),
        );
        for (const sessionId of lastDeliveredAt.keys()) {
          if (!present.has(sessionId)) {
            lastDeliveredAt.delete(sessionId);
          }
        }
      }

      for (const snapshot of snapshots) {
        const previousUpdatedAt = lastDeliveredAt.get(snapshot.sessionId) ?? -1;
        if (previousUpdatedAt >= snapshot.updatedAt) {
          continue;
        }
        lastDeliveredAt.set(snapshot.sessionId, snapshot.updatedAt);
        broadcastToWindows(context, IPC_OFFICE_PREVIEW_UPDATE, snapshot);
      }

      // Only poll at the active 1s cadence while sessions exist; otherwise fall
      // back to the idle heartbeat so an app with no previews is not doing a
      // readdir every second. The scan body is unchanged either way.
      arm(snapshots.length > 0 ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
    } catch (error) {
      console.debug(
        "[office-preview] Failed to scan preview sessions:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  void scan();
  // Start on the idle cadence; the first scan upgrades to the active cadence if
  // sessions are already present.
  arm(IDLE_POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (watchKickTimer) {
      clearTimeout(watchKickTimer);
      watchKickTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };
};
