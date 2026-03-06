/**
 * stella-ui HTTP bridge server.
 *
 * Runs on localhost with a random port. Receives commands from the
 * stella-ui CLI (invoked by agents via Bash) and forwards them to the
 * renderer via webContents.executeJavaScript, or handles generate
 * commands directly in the main process.
 */

import fs from "fs";
import path from "path";
import http from "http";
import type { BrowserWindow } from "electron";

let server: http.Server | null = null;

// ---------------------------------------------------------------------------
// Panel name → file path resolution
// ---------------------------------------------------------------------------

/** Known default home view panels and their source files. */
const DEFAULT_PANEL_MAP: Record<string, string> = {
  "news feed": "src/app/home/NewsFeed.tsx",
  "image gallery": "src/app/home/ImageGallery.tsx",
  "music player": "src/app/home/MusicPlayer.tsx",
  "generativecanvas": "src/app/home/GenerativeCanvas.tsx",
  "suggestions": "src/app/home/SuggestionsPanel.tsx",
  "active tasks": "src/app/home/ActiveTasks.tsx",
  "activity feed": "src/app/home/ActivityFeed.tsx",
};

function resolvePanelFile(panelName: string, frontendRoot: string): string | null {
  const normalized = panelName.toLowerCase().trim();

  // Check default panels
  const defaultFile = DEFAULT_PANEL_MAP[normalized];
  if (defaultFile) {
    const fullPath = path.join(frontendRoot, defaultFile);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  // Check workspace pages directory
  const pagesDir = path.join(frontendRoot, "src", "views", "home", "pages");
  try {
    const entries = fs.readdirSync(pagesDir);
    for (const entry of entries) {
      const name = entry.replace(/\.(tsx|jsx)$/, "").toLowerCase();
      if (name === normalized || name === normalized.replace(/\s+/g, "-") || name === normalized.replace(/\s+/g, "_")) {
        return path.join(pagesDir, entry);
      }
    }
  } catch {
    // No pages directory
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM call for generate command
// ---------------------------------------------------------------------------

const GENERATE_SYSTEM_PROMPT = `You are a React component generator for Stella, a desktop AI assistant.
You receive the current source code of a React component and a user prompt describing what content to show.
Return ONLY the updated component source code — no explanation, no markdown fences, no commentary.
Preserve the component's exports, imports structure, and data-stella-* attributes.
Use the existing CSS classes and styling patterns from the original component.
Replace placeholder/skeleton content with real content based on the prompt.
If the component needs data, hardcode it inline (no API calls needed — this is for display).`;

async function callGenerateModel(
  currentSource: string,
  prompt: string,
  proxyBaseUrl: string,
  proxyToken: string,
): Promise<string> {
  const modelId = "inception/mercury-2";

  const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${proxyToken}`,
      "X-Provider": "inception",
      "X-Model-Id": modelId,
      "X-Agent-Type": "panel-generate",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: GENERATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Current component source:\n\`\`\`tsx\n${currentSource}\n\`\`\`\n\nUpdate this component to: ${prompt}`,
        },
      ],
      max_tokens: 8192,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Generate model call failed (${response.status}): ${detail}`);
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Generate model returned no content");
  }

  // Strip markdown fences if the model included them
  return content
    .replace(/^```(?:tsx|typescript|jsx|javascript)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startStellaUiServer(opts: {
  getWindow: () => BrowserWindow | null;
  frontendRoot: string;
  getProxy: () => { baseUrl: string; token: string } | null;
}): number {
  if (server) {
    const addr = server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
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
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid JSON");
      return;
    }

    const command = String(body.command ?? "");
    const args = Array.isArray(body.args) ? body.args.map(String) : [];

    // Handle generate command in main process (no renderer needed)
    if (command === "generate") {
      const panelName = args[0] ?? "";
      const prompt = args.slice(1).join(" ");

      if (!panelName || !prompt) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Usage: stella-ui generate <panel-name> <prompt>");
        return;
      }

      const filePath = resolvePanelFile(panelName, opts.frontendRoot);
      if (!filePath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Panel not found: "${panelName}". Available panels: ${Object.keys(DEFAULT_PANEL_MAP).join(", ")}`);
        return;
      }

      const proxy = opts.getProxy();
      if (!proxy) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("LLM proxy not configured yet");
        return;
      }

      try {
        const currentSource = fs.readFileSync(filePath, "utf-8");
        const updatedSource = await callGenerateModel(currentSource, prompt, proxy.baseUrl, proxy.token);
        fs.writeFileSync(filePath, updatedSource, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`Updated ${path.basename(filePath)}`);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Generate failed: ${(err as Error).message}`);
      }
      return;
    }

    // All other commands forward to renderer
    const win = opts.getWindow();
    if (!win || win.isDestroyed()) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Window not available");
      return;
    }

    try {
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
