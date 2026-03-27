import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { bin, install } from "cloudflared";

export class CloudflareTunnelService {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private bridgePort: number | null = null;
  private started = false;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      getAuthToken: () => Promise<string | null>;
      getConvexSiteUrl: () => string | null;
      onTunnelUrl: (url: string | null) => void;
    },
  ) {}

  setBridgePort(port: number) {
    this.bridgePort = port;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    if (!this.bridgePort) {
      console.log("[cloudflare-tunnel] No bridge port set, skipping start");
      return;
    }

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
        if (line.includes("Registered tunnel connection")) {
          this.tunnelUrl = `https://${hostname}`;
          console.log(`[cloudflare-tunnel] Connected: ${this.tunnelUrl}`);
          this.options.onTunnelUrl(this.tunnelUrl);
          this.retryCount = 0;
        }
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          console.log(`[cloudflare-tunnel] ${line}`);
        }
      });

      this.process.on("exit", (code) => {
        console.log(`[cloudflare-tunnel] Process exited with code ${code}`);
        this.process = null;
        this.tunnelUrl = null;
        this.options.onTunnelUrl(null);

        if (!this.started) return;

        const delay = Math.min(30_000, 1000 * Math.pow(2, this.retryCount));
        this.retryCount++;
        console.log(
          `[cloudflare-tunnel] Restarting in ${delay}ms (attempt ${this.retryCount})`,
        );
        this.retryTimer = setTimeout(() => {
          this.started = false;
          void this.start();
        }, delay);
      });
    } catch (error) {
      console.error(
        "[cloudflare-tunnel] Failed to start:",
        (error as Error).message,
      );
      this.started = false;

      const delay = Math.min(30_000, 1000 * Math.pow(2, this.retryCount));
      this.retryCount++;
      this.retryTimer = setTimeout(() => void this.start(), delay);
    }
  }

  stop() {
    this.started = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.process) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(this.process.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        this.process.kill("SIGTERM");
      }
      this.process = null;
    }
    this.tunnelUrl = null;
    this.options.onTunnelUrl(null);
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

    const response = await fetch(
      `${siteUrl.replace(/\/+$/, "")}/api/mobile/desktop-bridge/tunnel-token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Tunnel token request failed: ${response.status}`);
    }

    return (await response.json()) as { tunnelToken: string; hostname: string };
  }
}
