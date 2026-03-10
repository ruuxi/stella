/**
 * stella-ui HTTP bridge server.
 *
 * Receives commands from the stella-ui CLI (invoked by agents via Bash)
 * and forwards them to the renderer, or handles generate commands
 * directly in the main process.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import type { BrowserWindow } from "electron";
import { streamManagedChatCompletion } from "../core/runtime/chat-completions.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "./private-fs.js";

let server: http.Server | null = null;
let serverTokenPath: string | null = null;
let serverToken: string | null = null;

const TOKEN_HEADER = "x-stella-ui-token";

const resolveStellaUiStatePath = (statePath?: string) =>
  statePath ?? path.resolve(process.cwd(), ".stella", "state");

export function getStellaUiSocketPath(statePath?: string): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\stella-ui";
  }
  return path.join(resolveStellaUiStatePath(statePath), "stella-ui.sock");
}

export function getStellaUiTokenPath(statePath?: string): string {
  return path.join(resolveStellaUiStatePath(statePath), "stella-ui.token");
}

const DEFAULT_PANEL_MAP: Record<string, string> = {
  "image gallery": "src/app/home/ImageGallery.tsx",
  "music player": "src/app/home/MusicPlayer.tsx",
  generativecanvas: "src/app/home/GenerativeCanvas.tsx",
  suggestions: "src/app/home/SuggestionsPanel.tsx",
  "active tasks": "src/app/home/ActiveTasks.tsx",
  "activity feed": "src/app/home/ActivityFeed.tsx",
};

function resolvePanelFile(panelName: string, frontendRoot: string): string | null {
  const normalized = panelName.toLowerCase().trim();

  const defaultFile = DEFAULT_PANEL_MAP[normalized];
  if (defaultFile) {
    const fullPath = path.join(frontendRoot, defaultFile);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  const pagesDir = path.join(frontendRoot, "src", "views", "home", "pages");
  try {
    const entries = fs.readdirSync(pagesDir);
    for (const entry of entries) {
      const name = entry.replace(/\.(tsx|jsx)$/, "").toLowerCase();
      if (
        name === normalized ||
        name === normalized.replace(/\s+/g, "-") ||
        name === normalized.replace(/\s+/g, "_")
      ) {
        return path.join(pagesDir, entry);
      }
    }
  } catch {
    // No pages directory.
  }

  return null;
}

const GENERATE_SYSTEM_PROMPT = `You are a React component updater for Stella, a desktop AI assistant.
You receive the current source code of a React component and a prompt describing what content to display.
Return ONLY the updated component source code - no explanation, no markdown fences, no commentary.

CRITICAL RULES:
- NEVER change component behavior, hooks, event handlers, callbacks, or state logic.
- NEVER add useEffect, useState, or modify existing hooks.
- NEVER change function signatures, props, or exports.
- ONLY change static/display content: text, labels, hardcoded data arrays, placeholder strings.
- Preserve ALL imports, exports, data-stella-* attributes, CSS classes, and component structure exactly.
- If the component has placeholder/skeleton content, replace it with real content matching the prompt.
- If the component already has real content, update the content to match the prompt.
- Hardcode display data inline (no API calls).`;

async function callGenerateModel(
  currentSource: string,
  prompt: string,
  proxyBaseUrl: string,
  authToken: string,
): Promise<string> {
  const fullContent = await streamManagedChatCompletion({
    transport: {
      endpoint: `${proxyBaseUrl}/chat/completions`,
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
    request: {
      agentType: "panel-generate",
      messages: [
        { role: "system", content: GENERATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Current component source:\n\`\`\`tsx\n${currentSource}\n\`\`\`\n\nUpdate this component to: ${prompt}`,
        },
      ],
    },
    body: {
      max_completion_tokens: 8192,
      temperature: 1.0,
    },
    onChunk: () => {},
  });

  const content = fullContent.trim();
  if (!content) {
    throw new Error("Generate model returned no content");
  }

  return content
    .replace(/^```(?:tsx|typescript|jsx|javascript)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

const noStoreHeaders = {
  "Content-Type": "text/plain",
  "Cache-Control": "no-store",
};

export function startStellaUiServer(opts: {
  getWindow: () => BrowserWindow | null;
  frontendRoot: string;
  statePath: string;
  getProxy: () => { baseUrl: string; authToken: string } | null;
}): number {
  if (server) {
    const addr = server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  serverToken = crypto.randomUUID();
  serverTokenPath = getStellaUiTokenPath(opts.statePath);
  writePrivateFileSync(serverTokenPath, serverToken);

  server = http.createServer(async (req, res) => {
    if (req.headers[TOKEN_HEADER] !== serverToken) {
      res.writeHead(401, noStoreHeaders);
      res.end("Unauthorized");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, noStoreHeaders);
      res.end("Method Not Allowed");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    let body: { command: string; args: string[] };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      res.writeHead(400, noStoreHeaders);
      res.end("Invalid JSON");
      return;
    }

    const command = String(body.command ?? "");
    const args = Array.isArray(body.args) ? body.args.map(String) : [];

    if (command === "generate") {
      const panelName = args[0] ?? "";
      const prompt = args.slice(1).join(" ");

      if (!panelName || !prompt) {
        res.writeHead(400, noStoreHeaders);
        res.end("Usage: stella-ui generate <panel-name> <prompt>");
        return;
      }

      const filePath = resolvePanelFile(panelName, opts.frontendRoot);
      if (!filePath) {
        res.writeHead(404, noStoreHeaders);
        res.end(
          `Panel not found: "${panelName}". Available panels: ${Object.keys(DEFAULT_PANEL_MAP).join(", ")}`,
        );
        return;
      }

      const proxy = opts.getProxy();
      if (!proxy) {
        res.writeHead(503, noStoreHeaders);
        res.end("LLM proxy not configured yet");
        return;
      }

      try {
        const currentSource = fs.readFileSync(filePath, "utf-8");
        const updatedSource = await callGenerateModel(
          currentSource,
          prompt,
          proxy.baseUrl,
          proxy.authToken,
        );
        fs.writeFileSync(filePath, updatedSource, "utf-8");
        res.writeHead(200, noStoreHeaders);
        res.end(`Updated ${path.basename(filePath)}`);
      } catch (err) {
        res.writeHead(500, noStoreHeaders);
        res.end(`Generate failed: ${(err as Error).message}`);
      }
      return;
    }

    const win = opts.getWindow();
    if (!win || win.isDestroyed()) {
      res.writeHead(503, noStoreHeaders);
      res.end("Window not available");
      return;
    }

    try {
      const result = await win.webContents.executeJavaScript(
        `window.__stellaUI?.handleCommand(${JSON.stringify(command)}, ${JSON.stringify(args)}) ?? "stella-ui handler not loaded"`,
      );

      res.writeHead(200, noStoreHeaders);
      res.end(String(result));
    } catch (err) {
      res.writeHead(500, noStoreHeaders);
      res.end(`Error: ${(err as Error).message}`);
    }
  });

  const socketPath = getStellaUiSocketPath(opts.statePath);
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Ignore stale socket cleanup failures.
  }

  if (process.platform !== "win32") {
    ensurePrivateDirSync(path.dirname(socketPath));
  }

  server.listen(socketPath);
  return 0;
}

export function stopStellaUiServer() {
  if (server) {
    server.close();
    server = null;
  }
  if (serverTokenPath) {
    try {
      fs.unlinkSync(serverTokenPath);
    } catch {
      // Ignore token cleanup failures.
    }
  }
  serverTokenPath = null;
  serverToken = null;
}
