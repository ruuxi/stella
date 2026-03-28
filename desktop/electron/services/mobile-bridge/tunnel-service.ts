import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { bin, install } from "cloudflared";
import { stopChildProcessTree } from "../../process-runtime.js";

export class CloudflareTunnelService {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private bridgePort: number | null = null;
  private started = false;

  constructor(
    private readonly options: {
      getAuthToken: () => Promise<string | null>;
      getConvexSiteUrl: () => string | null;
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
        if (line.includes("Registered tunnel connection")) {
          this.tunnelUrl = `https://${hostname}`;
          console.log(`[cloudflare-tunnel] Connected: ${this.tunnelUrl}`);
          this.options.onTunnelUrl(this.tunnelUrl);
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
    if (this.process) {
      await stopChildProcessTree(this.process);
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
