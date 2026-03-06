/**
 * stella-ui HTTP bridge server.
 *
 * Runs on localhost with a random port. Receives commands from the
 * stella-ui CLI (invoked by agents via Bash) and forwards them to the
 * renderer via webContents.executeJavaScript.
 */

import http from "http";
import type { BrowserWindow } from "electron";

let server: http.Server | null = null;

export function startStellaUiServer(
  getWindow: () => BrowserWindow | null,
): number {
  if (server) {
    const addr = server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  server = http.createServer(async (req, res) => {
    // Only accept POST from localhost
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    let body: { command: string; args: string[] };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid JSON");
      return;
    }

    const win = getWindow();
    if (!win || win.isDestroyed()) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Window not available");
      return;
    }

    try {
      const command = String(body.command ?? "");
      const args = Array.isArray(body.args) ? body.args.map(String) : [];

      const result = await win.webContents.executeJavaScript(
        `window.__stellaUI?.handleCommand(${JSON.stringify(command)}, ${JSON.stringify(args)}) ?? "stella-ui handler not loaded"`,
      );

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(String(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  });

  server.listen(0, "127.0.0.1");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return port;
}

export function stopStellaUiServer() {
  if (server) {
    server.close();
    server = null;
  }
}
