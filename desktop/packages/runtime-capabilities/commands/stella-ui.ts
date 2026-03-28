import { promises as fs } from "node:fs";
import path from "node:path";
import { streamStellaChatCompletion } from "../../runtime-kernel/stella-provider.js";
import type { CapabilityCommandDefinition } from "../types.js";

const DEFAULT_PANEL_MAP: Record<string, string> = {
  "image gallery": "src/app/home/ImageGallery.tsx",
  "music player": "src/app/home/MusicPlayer.tsx",
  generativecanvas: "src/app/home/GenerativeCanvas.tsx",
  suggestions: "src/app/home/SuggestionsPanel.tsx",
  "active tasks": "src/app/home/ActiveTasks.tsx",
  "activity feed": "src/app/home/ActivityFeed.tsx",
};

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

const resolvePanelFile = async (panelName: string, frontendRoot: string) => {
  const normalized = panelName.toLowerCase().trim();
  const defaultFile = DEFAULT_PANEL_MAP[normalized];
  if (defaultFile) {
    const fullPath = path.join(frontendRoot, defaultFile);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // Ignore and continue.
    }
  }

  const pagesDir = path.join(frontendRoot, "src", "views", "home", "pages");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(pagesDir);
  } catch {
    return null;
  }

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

  return null;
};

const callGenerateModel = async (args: {
  currentSource: string;
  prompt: string;
  siteBaseUrl: string;
  authToken: string;
}) => {
  const fullContent = await streamStellaChatCompletion({
    transport: {
      endpoint: `${args.siteBaseUrl}/chat/completions`,
      headers: {
        Authorization: `Bearer ${args.authToken}`,
      },
    },
    request: {
      agentType: "panel-generate",
      messages: [
        { role: "system", content: GENERATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Current component source:\n\`\`\`tsx\n${args.currentSource}\n\`\`\`\n\nUpdate this component to: ${args.prompt}`,
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
};

const usage = `stella-ui - control Stella's UI from the command line

Usage:
  stella-ui snapshot
  stella-ui click <ref>
  stella-ui fill <ref> <text>
  stella-ui select <ref> <value>
  stella-ui generate <panel> <prompt>`;

export const stellaUiCommand: CapabilityCommandDefinition = {
  id: "stella-ui",
  description: "Inspect and manipulate Stella's live desktop UI.",
  argumentHint: "<snapshot|click|fill|select|generate> [...]",
  sourcePath: "builtin:stella-ui",
  async execute(context) {
    const [subcommand, ...args] = context.argv;
    if (!subcommand) {
      return { exitCode: 0, stdout: usage };
    }

    if (subcommand === "snapshot") {
      return {
        exitCode: 0,
        stdout: await context.host.ui.snapshot(),
      };
    }

    if (subcommand === "click") {
      const ref = args[0] ?? "";
      return {
        exitCode: 0,
        stdout: await context.host.ui.act({ action: "click", ref }),
      };
    }

    if (subcommand === "fill") {
      const ref = args[0] ?? "";
      const value = args.slice(1).join(" ");
      return {
        exitCode: 0,
        stdout: await context.host.ui.act({ action: "fill", ref, value }),
      };
    }

    if (subcommand === "select") {
      const ref = args[0] ?? "";
      const value = args.slice(1).join(" ");
      return {
        exitCode: 0,
        stdout: await context.host.ui.act({ action: "select", ref, value }),
      };
    }

    if (subcommand === "generate") {
      const panelName = args[0] ?? "";
      const prompt = args.slice(1).join(" ").trim();
      if (!panelName || !prompt) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Usage: stella-ui generate <panel-name> <prompt>",
        };
      }
      const filePath = await resolvePanelFile(panelName, context.frontendRoot);
      if (!filePath) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Panel not found: "${panelName}"`,
        };
      }
      const siteAuth = context.getStellaSiteAuth();
      if (!siteAuth) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Stella site URL not configured yet",
        };
      }
      const currentSource = await fs.readFile(filePath, "utf-8");
      const updatedSource = await callGenerateModel({
        currentSource,
        prompt,
        siteBaseUrl: siteAuth.baseUrl,
        authToken: siteAuth.authToken,
      });
      await fs.writeFile(filePath, updatedSource, "utf-8");
      return {
        exitCode: 0,
        stdout: `Updated ${path.basename(filePath)}`,
      };
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown stella-ui command: ${subcommand}`,
    };
  },
};
