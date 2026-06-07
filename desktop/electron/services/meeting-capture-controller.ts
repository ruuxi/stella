import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { systemPreferences } from "electron";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { pidMatchesHelperBinary } from "./helper-pid-guard.js";
import { hasMacPermission, requestMacPermission } from "../utils/macos-permissions.js";

/**
 * MeetingCaptureController owns the lifecycle of the `meeting_capture` native
 * sidecar — a Granola-style dual-stream recorder that writes rolling WAV
 * segments under `<stellaHome>/meetings/<sessionId>/`. System audio + mic are
 * captured via ScreenCaptureKit + AVAudioEngine on macOS, and WASAPI loopback +
 * WASAPI capture on Windows. The TS control surface is identical on both: it
 * shells out to the helper's client verbs, which talk to the daemon over an
 * AF_UNIX socket (macOS) or named pipe (Windows).
 *
 * Unlike Chronicle, meeting capture is session-based rather than always-on:
 * the daemon stays idle until `start()` and only records between start and
 * stop. The daemon process itself is kept alive across recordings (cheap, and
 * avoids a cold ScreenCaptureKit spin-up per meeting); `shutdown()` tears it
 * down on app quit.
 */

const STARTUP_TIMEOUT_MS = 4_000;
const STARTUP_POLL_MS = 150;
const DEFAULT_SEGMENT_SECONDS = 30;

export type MeetingStartResult = {
  ok: boolean;
  sessionId?: string;
  dir?: string;
  segmentSeconds?: number;
  system?: boolean;
  mic?: boolean;
  startedAtMs?: number;
  reason?: string;
};

export type MeetingStopResult = {
  ok: boolean;
  sessionId?: string;
  dir?: string;
  durationMs?: number;
  systemSegments?: number;
  micSegments?: number;
  reason?: string;
};

export type MeetingStatus = {
  available: boolean;
  running: boolean;
  recording: boolean;
  paused: boolean;
  sessionId: string | null;
  startedAtMs: number | null;
  segmentSeconds: number;
  screenPermission: boolean;
  micPermission: boolean;
};

// The daemon is spawned detached + unref'd and the in-memory child handle is
// dropped on spawn error, so on quit we can't rely on `this.child` alone to
// reap it (orphan risk). Persist the pid to a file at spawn time and, if the
// socket `shutdown` didn't confirm exit, SIGTERM/SIGKILL the pidfile pid — the
// same belt-and-suspenders teardown as desktop-automation-cleanup.ts. The
// socket shutdown stays the primary path.
const meetingPidFile = (stellaHome: string): string =>
  path.join(stellaHome, "meetings", "meeting_capture.pid");

const readPidFile = (filePath: string): number | null => {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Exists but unsignalable → treat as alive so we still attempt SIGTERM.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MeetingCaptureController {
  private child: ChildProcess | null = null;
  private binPath: string | null = null;

  constructor(private readonly stellaHome: string) {}

  private resolveBin(): string | null {
    if (this.binPath) return this.binPath;
    this.binPath = resolveNativeHelperPath("meeting_capture");
    return this.binPath;
  }

  private async runCommand(args: string[]): Promise<string | null> {
    const bin = this.resolveBin();
    if (!bin) return null;
    return await new Promise<string | null>((resolve) => {
      execFile(
        bin,
        [...args, "--root", this.stellaHome],
        { timeout: 10_000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(stdout.toString().trim());
        },
      );
    });
  }

  private parseJson(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async waitForDaemonReady(timeoutMs = STARTUP_TIMEOUT_MS): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if ((await this.runCommand(["ping"])) === "pong") {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
    }
    return false;
  }

  /**
   * Spawn the daemon if it isn't already answering on its IPC channel
   * (AF_UNIX socket on macOS, named pipe on Windows). Linux has no native
   * system-audio path here yet.
   */
  private async ensureDaemon(): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return { ok: false, reason: "unsupported-platform" };
    }
    const bin = this.resolveBin();
    if (!bin) {
      return { ok: false, reason: "binary-missing" };
    }
    if ((await this.runCommand(["ping"])) === "pong") {
      return { ok: true };
    }

    try {
      await fs.mkdir(path.join(this.stellaHome, "meetings"), { recursive: true });
    } catch {
      // daemon will retry creating dirs
    }

    const child = spawn(bin, ["daemon", "--root", this.stellaHome], {
      detached: true,
      stdio: "ignore",
    });
    this.child = child;
    // Persist the pid so quit can reap the daemon even after the in-memory
    // handle is dropped (spawn error / process restart). Best-effort: a missing
    // pidfile just falls back to the socket shutdown.
    if (typeof child.pid === "number") {
      try {
        await fs.writeFile(meetingPidFile(this.stellaHome), String(child.pid));
      } catch {
        // ignored — socket shutdown remains the primary teardown path
      }
    }
    let spawnErrorMessage: string | null = null;
    child.on("error", (error) => {
      spawnErrorMessage = error.message;
      this.child = null;
    });
    child.unref();
    child.on("exit", () => {
      this.child = null;
    });

    if (!(await this.waitForDaemonReady())) {
      return { ok: false, reason: spawnErrorMessage ?? "startup-timeout" };
    }
    return { ok: true };
  }

  private getMicPermission(): boolean {
    if (process.platform !== "darwin") return true;
    try {
      return systemPreferences.getMediaAccessStatus("microphone") === "granted";
    } catch {
      return false;
    }
  }

  /**
   * Begin a recording. Ensures the daemon is up and that Screen Recording (for
   * system audio) and Microphone (for your voice) permissions are granted,
   * prompting the user via TCC if needed. The mic is best-effort: a recording
   * still proceeds system-audio-only if the mic is unavailable.
   */
  async start(options?: {
    sessionId?: string;
    segmentSeconds?: number;
  }): Promise<MeetingStartResult> {
    const daemon = await this.ensureDaemon();
    if (!daemon.ok) {
      return { ok: false, reason: daemon.reason ?? "daemon-failed" };
    }

    if (!hasMacPermission("screen", false)) {
      const result = await requestMacPermission("screen");
      if (!result.granted) {
        return { ok: false, reason: "needs-screen-permission" };
      }
    }

    // Best-effort mic: prompt once if undetermined, but never block the
    // recording on a denied mic — system audio alone is still useful.
    if (process.platform === "darwin" && !this.getMicPermission()) {
      try {
        await systemPreferences.askForMediaAccess("microphone");
      } catch {
        // ignored — recording proceeds without the mic
      }
    }

    const segmentSeconds = Math.max(
      1,
      Math.floor(options?.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS),
    );
    const args = ["start", "--segment-seconds", String(segmentSeconds)];
    if (options?.sessionId) {
      args.push("--session-id", options.sessionId);
    }
    const parsed = this.parseJson(await this.runCommand(args));
    if (!parsed) {
      return { ok: false, reason: "start-failed" };
    }
    if (parsed.ok !== true) {
      return { ok: false, reason: String(parsed.error ?? "start-failed") };
    }
    return {
      ok: true,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      dir: typeof parsed.dir === "string" ? parsed.dir : undefined,
      segmentSeconds:
        typeof parsed.segmentSeconds === "number" ? parsed.segmentSeconds : segmentSeconds,
      system: parsed.system === true,
      mic: parsed.mic === true,
      startedAtMs:
        typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : undefined,
    };
  }

  async pause(): Promise<boolean> {
    const parsed = this.parseJson(await this.runCommand(["pause"]));
    return parsed?.ok === true;
  }

  async resume(): Promise<boolean> {
    const parsed = this.parseJson(await this.runCommand(["resume"]));
    return parsed?.ok === true;
  }

  async stop(): Promise<MeetingStopResult> {
    const parsed = this.parseJson(await this.runCommand(["stop"]));
    if (!parsed) {
      return { ok: false, reason: "stop-failed" };
    }
    if (parsed.ok !== true) {
      return { ok: false, reason: String(parsed.error ?? "stop-failed") };
    }
    return {
      ok: true,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      dir: typeof parsed.dir === "string" ? parsed.dir : undefined,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
      systemSegments:
        typeof parsed.systemSegments === "number" ? parsed.systemSegments : undefined,
      micSegments:
        typeof parsed.micSegments === "number" ? parsed.micSegments : undefined,
    };
  }

  async status(): Promise<MeetingStatus> {
    const bin = this.resolveBin();
    const micPermission = this.getMicPermission();
    const screenPermission =
      process.platform === "darwin" ? hasMacPermission("screen", false) : true;
    if (!bin) {
      return {
        available: false,
        running: false,
        recording: false,
        paused: false,
        sessionId: null,
        startedAtMs: null,
        segmentSeconds: DEFAULT_SEGMENT_SECONDS,
        screenPermission,
        micPermission,
      };
    }
    const parsed = this.parseJson(await this.runCommand(["status"]));
    if (!parsed) {
      return {
        available: true,
        running: false,
        recording: false,
        paused: false,
        sessionId: null,
        startedAtMs: null,
        segmentSeconds: DEFAULT_SEGMENT_SECONDS,
        screenPermission,
        micPermission,
      };
    }
    const sessionId =
      typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
        ? parsed.sessionId
        : null;
    return {
      available: true,
      running: parsed.running === true,
      recording: parsed.recording === true,
      paused: parsed.paused === true,
      sessionId,
      startedAtMs:
        typeof parsed.startedAtMs === "number" && parsed.startedAtMs > 0
          ? parsed.startedAtMs
          : null,
      segmentSeconds:
        typeof parsed.segmentSeconds === "number"
          ? parsed.segmentSeconds
          : DEFAULT_SEGMENT_SECONDS,
      screenPermission:
        typeof parsed.screenPermission === "boolean"
          ? parsed.screenPermission
          : screenPermission,
      micPermission,
    };
  }

  /** Finalize any active recording and stop the daemon. Used on app quit. */
  async shutdown(): Promise<void> {
    // Primary path: ask the daemon to finalize + shut itself down over the
    // socket.
    await this.runCommand(["shutdown"]);
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already stopped
      }
    }
    this.child = null;

    // Fallback: if the socket shutdown didn't actually take the process down
    // (e.g. the daemon was orphaned across a restart, so `this.child` is null),
    // SIGTERM the persisted pid, give it a beat, then SIGKILL — then drop the
    // pidfile so the next launch never reaps a recycled pid.
    //
    // Guard against pid REUSE: a stale pidfile from an unclean prior quit can
    // point at an unrelated process the OS recycled the pid for. Only signal it
    // when we can confirm the live process is actually our meeting_capture
    // helper (command-line/image match); otherwise leave it and drop the file.
    const pidFile = meetingPidFile(this.stellaHome);
    const pid = readPidFile(pidFile);
    const bin = this.resolveBin();
    if (
      pid !== null &&
      isProcessAlive(pid) &&
      bin !== null &&
      pidMatchesHelperBinary(pid, bin, ["--root", this.stellaHome])
    ) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      await sleep(150);
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    try {
      await fs.rm(pidFile, { force: true });
    } catch {
      // ignored — stale pidfile is harmless (next shutdown re-checks liveness)
    }
  }
}
