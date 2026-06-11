import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { bin, install } from "cloudflared";
import { stopChildProcessTree } from "../../process-runtime.js";
import { probeBridgePublicHealth } from "./public-health.js";

/**
 * After cloudflared reports a registered connection we don't immediately trust
 * that the public hostname is routable — the Cloudflare edge can take a moment
 * to start routing to a freshly (re)connected connector. We probe the public
 * `/bridge/health` endpoint and only advertise the tunnel URL once it answers,
 * so the phone never receives a URL that isn't actually reachable yet.
 */
const PUBLIC_READINESS_TIMEOUT_MS = 15_000;
const PUBLIC_READINESS_PROBE_TIMEOUT_MS = 2_000;
const PUBLIC_READINESS_RETRY_MS = 3_000;

export class CloudflareTunnelService {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private bridgePort: number | null = null;
  private started = false;
  private readinessStarted = false;

  constructor(
    private readonly options: {
      getAuthToken: () => Promise<string | null>;
      getConvexSiteUrl: () => string | null;
      getDeviceId: () => string | null;
      onTunnelUrl: (url: string | null) => void;
      onUnexpectedExit?: (error: string) => void;
    },
  ) {}

  setBridgePort(port: number) {
    this.bridgePort = port;
  }

  async start() {
    if (this.started || this.process) return;

    if (!this.bridgePort) {
      console.log("[cloudflare-tunnel] No bridge port set, skipping start");
      return;
    }

    this.started = true;

    try {
      const { tunnelToken, hostname } = await this.fetchTunnelToken();

      if (!fs.existsSync(bin)) {
        console.log("[cloudflare-tunnel] Installing cloudflared binary...");
        await install(bin);
      }

      console.log(
        `[cloudflare-tunnel] Starting tunnel to localhost:${this.bridgePort}`,
      );

      this.process = spawn(
        bin,
        [
          "tunnel",
          "run",
          "--url",
          `http://localhost:${this.bridgePort}`,
          "--token",
          tunnelToken,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      this.process.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        if (
          !this.readinessStarted &&
          line.includes("Registered tunnel connection")
        ) {
          this.readinessStarted = true;
          console.log(
            "[cloudflare-tunnel] Connector registered; verifying public reachability",
          );
          void this.announceWhenReachable(`https://${hostname}`);
        }
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          console.log(`[cloudflare-tunnel] ${line}`);
        }
      });

      this.process.on("exit", (code) => {
        const wasRunning = this.started;
        console.log(`[cloudflare-tunnel] Process exited with code ${code}`);
        this.process = null;
        this.started = false;
        this.readinessStarted = false;
        this.tunnelUrl = null;
        this.options.onTunnelUrl(null);

        if (!wasRunning) return;
        this.options.onUnexpectedExit?.(
          `Cloudflare tunnel exited with code ${code ?? 0}`,
        );
      });
    } catch (error) {
      this.started = false;
      console.error(
        "[cloudflare-tunnel] Failed to start:",
        (error as Error).message,
      );
      throw error;
    }
  }

  async stop() {
    this.started = false;
    this.readinessStarted = false;
    if (this.process) {
      await stopChildProcessTree(this.process);
      this.process = null;
    }
    this.tunnelUrl = null;
    this.options.onTunnelUrl(null);
  }

  /**
   * Wait until the public tunnel URL actually serves `/bridge/health`, then
   * advertise it. If it never becomes reachable within the timeout we advertise
   * anyway as a last resort, so a working-but-slow edge doesn't leave the phone
   * permanently unable to connect.
   */
  private async announceWhenReachable(url: string) {
    const reachable = await this.waitForPublicReadiness(url);
    // Bail if the tunnel was stopped or the process exited while we probed.
    if (!this.started || !this.process) return;
    if (reachable) {
      console.log(`[cloudflare-tunnel] Connected: ${url}`);
    } else {
      console.warn(
        `[cloudflare-tunnel] Public URL not reachable within ${PUBLIC_READINESS_TIMEOUT_MS}ms; advertising anyway: ${url}`,
      );
    }
    this.tunnelUrl = url;
    this.options.onTunnelUrl(url);
  }

  private async waitForPublicReadiness(url: string): Promise<boolean> {
    const deadline = Date.now() + PUBLIC_READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.started || !this.process) return false;
      if (
        await probeBridgePublicHealth(url, PUBLIC_READINESS_PROBE_TIMEOUT_MS)
      ) {
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PUBLIC_READINESS_RETRY_MS),
      );
    }
    return false;
  }

  private async fetchTunnelToken(): Promise<{
    tunnelToken: string;
    hostname: string;
  }> {
    const siteUrl = this.options.getConvexSiteUrl();
    const token = await this.options.getAuthToken();

    if (!siteUrl || !token) {
      throw new Error("Missing site URL or auth token");
    }

    const deviceId = this.options.getDeviceId()?.trim();
    if (!deviceId) {
      throw new Error("Missing desktop device id for tunnel token");
    }

    const response = await fetch(
      `${siteUrl.replace(/\/+$/, "")}/api/mobile/desktop-bridge/tunnel-token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deviceId }),
      },
    );

    if (!response.ok) {
      throw new Error(`Tunnel token request failed: ${response.status}`);
    }

    return (await response.json()) as { tunnelToken: string; hostname: string };
  }
}
