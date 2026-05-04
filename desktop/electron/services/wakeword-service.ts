import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { existsSync } from "node:fs";
import { resolveNativeHelperPath } from "../native-helper-path.js";

/**
 * Manages the lifecycle of the native `wakeword_listener` child process.
 *
 * The listener emits NDJSON `ready` / `wake` events on stdout. We translate
 * `wake` events into a single callback (`onWake`) that the bootstrap layer
 * wires to `togglePetVoice`. The listener auto-pauses while a voice session
 * is active so the assistant can't trigger itself.
 */

type WakewordEvent =
  | {
      event: "ready";
      models: string[];
      sample_rate: number;
      channels: number;
      device_name: string;
    }
  | {
      event: "wake";
      model: string;
      score: number;
      threshold: number;
      timestamp_ms: number;
    };

type WakewordOptions = {
  threshold: number;
  modelPath?: string;
  onWake: (event: Extract<WakewordEvent, { event: "wake" }>) => void;
  onReady?: (event: Extract<WakewordEvent, { event: "ready" }>) => void;
};

const RESTART_BACKOFF_MS = 5000;

const resolveModelPath = (binaryPath: string): string | null => {
  const helperDir = path.dirname(binaryPath);
  const candidates = [
    path.join(helperDir, "wakeword_models", "hey_stella.onnx"),
    // Dev fallback: source-tree model, in case the build script hasn't
    // staged it into out/ yet.
    path.resolve(
      helperDir,
      "..",
      "..",
      "wakeword",
      "models",
      "hey_stella.onnx",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

export class WakewordService {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer = "";
  private enabled = false;
  private paused = false;
  private disposed = false;

  constructor(private readonly options: WakewordOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.spawnIfIdle();
    } else {
      this.stopChild();
    }
  }

  /** Pause/resume without changing the user's enabled preference. Used to
   *  silence the listener while a voice session is active. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.stopChild();
    } else if (this.enabled) {
      this.spawnIfIdle();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopChild();
  }

  private spawnIfIdle(): void {
    if (this.disposed || !this.enabled || this.paused) return;
    if (this.child) return;
    if (this.restartTimer) return;

    const binaryPath = resolveNativeHelperPath("wakeword_listener");
    if (!binaryPath) {
      console.warn(
        "[wakeword] listener binary not found — wake word disabled.",
      );
      return;
    }

    const modelPath = this.options.modelPath ?? resolveModelPath(binaryPath);
    if (!modelPath) {
      console.warn(
        "[wakeword] hey_stella.onnx model not found near binary — wake word disabled.",
      );
      return;
    }

    const args = [
      "start",
      "--model",
      modelPath,
      "--threshold",
      this.options.threshold.toString(),
    ];

    let child: ChildProcess;
    try {
      child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      console.warn("[wakeword] failed to spawn listener:", error);
      this.scheduleRestart();
      return;
    }

    this.child = child;
    this.stdoutBuffer = "";

    const stdout = child.stdout as Readable | null;
    const stderr = child.stderr as Readable | null;
    if (!stdout || !stderr) {
      console.warn("[wakeword] listener spawned without stdio pipes");
      try {
        child.kill();
      } catch {
        // already gone
      }
      this.child = null;
      this.scheduleRestart();
      return;
    }
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      // Listener uses stderr only for fatal cpal/onnx errors; surface them
      // for debugging without spamming.
      const line = chunk.trim();
      if (line) console.warn("[wakeword]", line);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.disposed) return;
      if (code === 0 && signal === null) return;
      console.warn(
        `[wakeword] listener exited (code=${code} signal=${signal}); will retry`,
      );
      this.scheduleRestart();
    });
    child.on("error", (error) => {
      console.warn("[wakeword] listener error:", error.message);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      let parsed: WakewordEvent;
      try {
        parsed = JSON.parse(line) as WakewordEvent;
      } catch {
        continue;
      }
      if (parsed.event === "ready") {
        this.options.onReady?.(parsed);
      } else if (parsed.event === "wake") {
        try {
          this.options.onWake(parsed);
        } catch (error) {
          console.warn("[wakeword] onWake handler threw:", error);
        }
      }
    }
  }

  private stopChild(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill();
    } catch {
      // Already dead — ignore.
    }
  }

  private scheduleRestart(): void {
    if (this.disposed || !this.enabled || this.paused) return;
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnIfIdle();
    }, RESTART_BACKOFF_MS);
  }
}
