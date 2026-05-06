import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  STELLA_BROWSER_BRIDGE_PORT,
  STELLA_BROWSER_BRIDGE_SESSION,
  STELLA_BROWSER_BRIDGE_TOKEN,
  getStellaBrowserSocketDir,
} from "../../../runtime/kernel/tools/stella-browser-bridge-config.js";
import { registerStellaNativeMessagingHost } from "../utils/register-stella-native-messaging-host.js";
import { resolveStellaBrowserRoot } from "../utils/stella-browser-paths.js";
import { stopChildProcessTree } from "../process-runtime.js";

const DAEMON_READY_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 2_000;
const DAEMON_READY_PROBE_TIMEOUT_MS = 1_000;

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

type StellaBrowserBridgeServiceOptions = {
  stellaRoot: string;
  onUnexpectedExit?: (error: string) => void;
};

type DaemonResponse = {
  success?: boolean;
  error?: string;
  data?: unknown;
};

export class StellaBrowserBridgeService {
  private readonly stellaRoot: string;
  private readonly onUnexpectedExit?: (error: string) => void;

  private daemonProcess: ChildProcess | null = null;
  private launchPromise: Promise<void> | null = null;
  private isLaunching = false;
  private stopped = false;

  constructor(options: StellaBrowserBridgeServiceOptions) {
    this.stellaRoot = options.stellaRoot;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  start() {
    if (this.stopped) {
      this.stopped = false;
    }
    if (this.daemonProcess || this.launchPromise) {
      return this.launchPromise ?? Promise.resolve();
    }
    const launchPromise = this.launchBridge().finally(() => {
      if (this.launchPromise === launchPromise) {
        this.launchPromise = null;
      }
    });
    this.launchPromise = launchPromise;
    return launchPromise;
  }

  async stop() {
    this.stopped = true;

    const closePromise = this.sendCommand({
      id: randomUUID(),
      action: "close",
    }).catch(() => undefined);

    await Promise.race([closePromise, delay(1_500)]).catch(() => undefined);
    await this.killDaemonProcess();
    await this.stopOrphanedBundledDaemons();
    this.daemonProcess = null;
  }

  private async launchBridge() {
    if (this.stopped) {
      return;
    }

    this.isLaunching = true;

    try {
      const registration = registerStellaNativeMessagingHost();
      if (!registration.ok) {
        throw new Error(
          registration.error ??
            "Could not register the browser extension connector. Stella may need permission to update browser settings.",
        );
      }

      await this.closeExistingSession();
      this.spawnDaemon();
      await this.waitForDaemonReady();
      await this.sendCommand({
        id: randomUUID(),
        action: "launch",
        provider: "extension",
      });
    } catch (error) {
      await this.killDaemonProcess();
      throw error;
    } finally {
      this.isLaunching = false;
    }
  }

  private spawnDaemon() {
    const stellaBrowserRoot = resolveStellaBrowserRoot();
    const binPath = path.join(stellaBrowserRoot, "bin", "stella-browser.js");

    const daemon = spawn(process.execPath, [binPath], {
      cwd: stellaBrowserRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        STELLA_BROWSER_DAEMON: "1",
        STELLA_BROWSER_SESSION: STELLA_BROWSER_BRIDGE_SESSION,
        STELLA_BROWSER_EXT_PORT: STELLA_BROWSER_BRIDGE_PORT,
        STELLA_BROWSER_EXT_TOKEN: STELLA_BROWSER_BRIDGE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    daemon.stdout?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) {
        console.debug("[stella-browser-bridge]", message);
      }
    });

    daemon.stderr?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) {
        console.warn("[stella-browser-bridge]", message);
      }
    });

    daemon.once("exit", (code, signal) => {
      if (this.daemonProcess !== daemon) {
        return;
      }

      this.daemonProcess = null;

      if (this.stopped || this.isLaunching) {
        return;
      }

      const reason = signal
        ? `Bridge process exited via ${signal}.`
        : `Bridge process exited with code ${code ?? 0}.`;
      this.onUnexpectedExit?.(reason);
    });

    daemon.once("error", (error) => {
      if (this.daemonProcess !== daemon) {
        return;
      }
      this.daemonProcess = null;
      if (this.stopped || this.isLaunching) {
        return;
      }
      this.onUnexpectedExit?.(`Failed to start browser bridge: ${error.message}`);
    });

    this.daemonProcess = daemon;
  }

  private async waitForDaemonReady() {
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.stopped) {
        throw new Error("Browser bridge startup cancelled.");
      }

      if (this.daemonProcess?.exitCode !== null) {
        throw new Error("Browser bridge daemon exited before it became ready.");
      }

      try {
        await this.sendCommand(
          {
            id: randomUUID(),
            action: "state_list",
          },
          DAEMON_READY_PROBE_TIMEOUT_MS,
        );
        return;
      } catch {
        await delay(100);
      }
    }

    throw new Error("Browser bridge daemon did not become ready in time.");
  }

  private async closeExistingSession() {
    const daemonPort = getPortForSession(STELLA_BROWSER_BRIDGE_SESSION);

    await this.sendCommand({
      id: randomUUID(),
      action: "close",
    }, 1_500).catch(() => undefined);

    const daemonStopped = await this.waitForPortToClose(
      daemonPort,
      DAEMON_SHUTDOWN_TIMEOUT_MS,
    );
    if (!daemonStopped) {
      this.killProcessListeningOnPort(daemonPort);
      await this.waitForPortToClose(daemonPort, DAEMON_SHUTDOWN_TIMEOUT_MS);
    }
    await this.stopOrphanedBundledDaemons();
  }

  private async sendCommand(
    command: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<DaemonResponse> {
    const socket = await this.openConnection();

    return await new Promise<DaemonResponse>((resolve, reject) => {
      let settled = false;
      let responseBuffer = "";

      const timeout = setTimeout(() => {
        settleReject(new Error("Timed out waiting for browser bridge daemon."));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
      };

      const settleResolve = (response: DaemonResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      socket.on("data", (chunk: Buffer | string) => {
        responseBuffer += String(chunk);
        const newlineIndex = responseBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        const line = responseBuffer.slice(0, newlineIndex).trim();
        if (!line) {
          return;
        }

        try {
          const response = JSON.parse(line) as DaemonResponse;
          if (response.success === false) {
            settleReject(
              new Error(response.error || "Browser bridge command failed."),
            );
            return;
          }
          settleResolve(response);
        } catch (error) {
          settleReject(
            new Error(
              `Failed to parse browser bridge response: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });

      socket.once("error", (error) => {
        settleReject(
          new Error(`Failed to reach browser bridge daemon: ${error.message}`),
        );
      });

      socket.once("close", () => {
        if (!settled) {
          settleReject(
            new Error("Browser bridge daemon closed before replying."),
          );
        }
      });

      socket.write(`${JSON.stringify(command)}\n`);
    });
  }

  private async openConnection(): Promise<net.Socket> {
    const endpoint =
      process.platform === "win32"
        ? { port: getPortForSession(STELLA_BROWSER_BRIDGE_SESSION), host: "127.0.0.1" }
        : { path: getSocketPath(STELLA_BROWSER_BRIDGE_SESSION) };

    return await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.once("connect", () => {
        socket.removeListener("error", rejectConnection);
        resolve(socket);
      });
      const rejectConnection = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", rejectConnection);
    });
  }

  private async killDaemonProcess() {
    if (!this.daemonProcess || this.daemonProcess.killed) {
      return;
    }
    await stopChildProcessTree(this.daemonProcess);
  }

  private parseProcessRows(output: string): ProcessRow[] {
    return output
      .split(/\r?\n/)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number.parseInt(match[1]!, 10),
          ppid: Number.parseInt(match[2]!, 10),
          command: match[3]!,
        };
      })
      .filter((row): row is ProcessRow =>
        Boolean(row && Number.isFinite(row.pid) && Number.isFinite(row.ppid)),
      );
  }

  private findOrphanedBundledDaemonPids(): number[] {
    const binDir = path.join(resolveStellaBrowserRoot(), "bin");
    if (process.platform === "win32") {
      const binaryPath = path.join(binDir, "stella-browser-win32-x64.exe");
      const quotedBinaryPath = binaryPath.replace(/'/g, "''");
      try {
        const output = execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            [
              `$target = '${quotedBinaryPath}'`,
              "Get-CimInstance Win32_Process -Filter \"Name = 'stella-browser-win32-x64.exe'\"",
              "| Where-Object { $_.ExecutablePath -eq $target -and $_.ProcessId -ne $PID }",
              "| Select-Object -ExpandProperty ProcessId -Unique",
            ].join("; "),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        return output
          .split(/\r?\n/)
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value) && value > 0);
      } catch {
        return [];
      }
    }

    const binaryNames = [
      "stella-browser-darwin-arm64",
      "stella-browser-darwin-x64",
    ];
    const binaryPaths = binaryNames.map((name) => path.join(binDir, name));

    try {
      const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return this.parseProcessRows(output)
        .filter(
          (row) =>
            row.pid !== process.pid &&
            row.ppid === 1 &&
            binaryPaths.some((binaryPath) => row.command.includes(binaryPath)),
        )
        .map((row) => row.pid);
    } catch {
      return [];
    }
  }

  private async stopOrphanedBundledDaemons() {
    const pids = this.findOrphanedBundledDaemonPids();
    if (pids.length === 0) return;
    for (const pid of pids) {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          continue;
        } catch {
          // Fall through to a direct kill attempt below.
        }
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
    await delay(150);
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
      } catch {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort stale daemon cleanup.
      }
    }
  }

  private getListeningProcessesForPort(port: number): number[] {
    if (!Number.isFinite(port) || port <= 0) {
      return [];
    }

    try {
      if (process.platform === "win32") {
        const output = execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );

        return output
          .split(/\r?\n/)
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value) && value > 0);
      }

      const output = execFileSync(
        "lsof",
        ["-ti", `tcp:${port}`, "-s", "tcp:listen"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );

      return output
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    } catch {
      return [];
    }
  }

  private async waitForPortToClose(port: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.getListeningProcessesForPort(port).length === 0) {
        return true;
      }
      await delay(100);
    }

    return this.getListeningProcessesForPort(port).length === 0;
  }

  private killProcessListeningOnPort(port: number) {
    const pids = this.getListeningProcessesForPort(port);

    for (const pid of pids) {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          continue;
        } catch {
          // Fall through to a direct kill attempt below.
        }
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Best-effort cleanup for stale daemon listeners.
      }
    }
  }
}

const getSocketDir = getStellaBrowserSocketDir;

const getSocketPath = (session: string) =>
  path.join(getSocketDir(), `${session}.sock`);

const getPortForSession = (session: string) => {
  let hash = 0;
  for (const char of session) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  const normalized = hash === -2147483648 ? 2147483648 : Math.abs(hash);
  return 49152 + (normalized % 16383);
};
