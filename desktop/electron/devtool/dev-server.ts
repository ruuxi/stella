/**
 * Dev-mode WebSocket debug server.
 *
 * Starts on a fixed port, broadcasts events from the dev event bus to
 * connected devtool clients, and handles commands sent back from the devtool.
 */

import http from "http";
import { app, session } from "electron";
import { promises as fs } from "fs";
import { WebSocketServer, type WebSocket } from "ws";
import { devEventBus, type DevEvent } from "./dev-event-bus.js";

export const DEVTOOL_PORT = 17710;

type DevServerCommand =
  | { command: "hard-reset" }
  | { command: "reload-app" }
  | { command: "ping" };

type DevServerDeps = {
  stellaHomePath: () => string | null;
  sessionPartition: string;
  shutdownRuntime: () => void;
  onReloadApp: () => void;
};

export class DevToolServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private unsubscribe: (() => void) | null = null;
  private deps: DevServerDeps;

  constructor(deps: DevServerDeps) {
    this.deps = deps;
  }

  start() {
    this.httpServer = http.createServer((_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", tool: "stella-devtool" }));
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws) => {
      console.log("[devtool] client connected");

      this.sendJson(ws, {
        type: "connected",
        stellaHomePath: this.deps.stellaHomePath(),
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as DevServerCommand;
          void this.handleCommand(ws, msg);
        } catch {
          this.sendJson(ws, { type: "error", message: "Invalid JSON" });
        }
      });

      ws.on("close", () => {
        console.log("[devtool] client disconnected");
      });
    });

    this.unsubscribe = devEventBus.subscribe((event) => {
      this.broadcast(event);
    });

    this.httpServer.listen(DEVTOOL_PORT, "127.0.0.1", () => {
      console.log(`[devtool] debug server listening on ws://127.0.0.1:${DEVTOOL_PORT}`);
    });

    this.httpServer.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.warn(
          `[devtool] port ${DEVTOOL_PORT} in use — debug server disabled`,
        );
        this.stop();
      } else {
        console.error("[devtool] server error:", err.message);
      }
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  private broadcast(event: DevEvent) {
    if (!this.wss || this.wss.clients.size === 0) return;

    const data = JSON.stringify({ type: "event", event });
    for (const client of this.wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data);
      }
    }
  }

  private sendJson(ws: WebSocket, data: unknown) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  private async handleCommand(ws: WebSocket, msg: DevServerCommand) {
    try {
      switch (msg.command) {
        case "ping":
          this.sendJson(ws, { type: "pong" });
          break;

        case "hard-reset": {
          const homePath = this.deps.stellaHomePath();
          // Shut down runtime first (close sqlite handles, etc.)
          this.deps.shutdownRuntime();
          // Clear Electron session storage (localStorage, cookies, cache)
          // This is where onboarding state lives
          const appSession = session.fromPartition(this.deps.sessionPartition);
          await Promise.allSettled([
            appSession.clearStorageData(),
            appSession.clearCache(),
          ]);
          // Nuke .stella/
          if (homePath) {
            await fs.rm(homePath, { recursive: true, force: true });
          }
          this.sendJson(ws, { type: "command-result", command: "hard-reset", ok: true });
          // Close the WS server so port is freed before restart
          this.stop();
          // Exit — dev-electron.mjs auto-restarts on unexpected exit
          app.exit(0);
          break;
        }

        case "reload-app":
          this.deps.onReloadApp();
          this.sendJson(ws, { type: "command-result", command: "reload-app", ok: true });
          break;

        default:
          this.sendJson(ws, { type: "error", message: `Unknown command: ${(msg as { command: string }).command}` });
      }
    } catch (err) {
      this.sendJson(ws, {
        type: "error",
        message: `Command failed: ${(err as Error).message}`,
      });
    }
  }
}
