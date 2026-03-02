/**
 * Local Suggestion Generation
 *
 * Reads the command catalog from bundled markdown files on disk,
 * builds a suggestion prompt from recent conversation context,
 * calls the LLM proxy, and returns 0-3 command suggestions.
 */

import { promises as fs } from "fs";
import path from "path";
import { generateText, type LanguageModel } from "ai";

type CommandEntry = {
  commandId: string;
  name: string;
  description: string;
};

type Suggestion = {
  commandId: string;
  name: string;
  description: string;
};

const SUGGESTION_PROMPT = `Based on the recent conversation, suggest 0-3 commands the user might want to run next.
Only suggest commands that are clearly relevant to the conversation context. Return an empty array if nothing fits.

## Available Commands
{catalog}

## Recent Conversation
{messages}

Return ONLY a JSON array (no markdown fences). Each element: {"commandId": "...", "name": "...", "description": "..."}
If no commands are relevant, return: []`;

// ─── Catalog loading (from disk) ─────────────────────────────────────────────

let cachedCatalog: CommandEntry[] | null = null;
let cachedCatalogPath: string | null = null;

function parseFrontmatter(content: string): {
  name: string;
  description: string;
} | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yaml = match[1]!;
  const fields: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  if (!fields["description"]) return null;
  return { name: fields["name"] || "", description: fields["description"] };
}

function deriveDisplayName(filename: string): string {
  return filename
    .replace(/\.md$/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function loadCatalogFromDisk(bundledCommandsPath: string): Promise<CommandEntry[]> {
  if (cachedCatalog && cachedCatalogPath === bundledCommandsPath) {
    return cachedCatalog;
  }

  const entries: CommandEntry[] = [];
  let pluginDirs: string[];

  try {
    const dirEntries = await fs.readdir(bundledCommandsPath, { withFileTypes: true });
    pluginDirs = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  for (const pluginDir of pluginDirs) {
    const pluginPath = path.join(bundledCommandsPath, pluginDir);
    let files: string[];
    try {
      files = (await fs.readdir(pluginPath)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(pluginPath, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const frontmatter = parseFrontmatter(content);
        const baseName = file.replace(/\.md$/, "");
        entries.push({
          commandId: `${pluginDir}--${baseName}`,
          name: frontmatter?.name || deriveDisplayName(file),
          description: frontmatter?.description || `${deriveDisplayName(file)} command`,
        });
      } catch {
        continue;
      }
    }
  }

  cachedCatalog = entries;
  cachedCatalogPath = bundledCommandsPath;
  return entries;
}

// ─── Suggestion generation ───────────────────────────────────────────────────

export type GenerateSuggestionsOpts = {
  model: LanguageModel;
  bundledCommandsPath: string;
  assistantText: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
};

export async function generateSuggestionsLocally(
  opts: GenerateSuggestionsOpts,
): Promise<Suggestion[] | null> {
  const catalog = await loadCatalogFromDisk(opts.bundledCommandsPath);
  if (catalog.length === 0) return null;

  // Build compact message summary from recent context
  const messageParts: string[] = [];
  for (const msg of opts.recentMessages.slice(-10)) {
    const text = msg.content.slice(0, 500);
    if (text) messageParts.push(`${msg.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  // Always include the latest assistant response
  if (opts.assistantText) {
    messageParts.push(`Assistant: ${opts.assistantText.slice(0, 500)}`);
  }
  if (messageParts.length === 0) return null;

  const catalogText = catalog
    .map((c) => `${c.commandId}: ${c.name} - ${c.description}`)
    .join("\n");

  const prompt = SUGGESTION_PROMPT
    .replace("{catalog}", catalogText)
    .replace("{messages}", messageParts.join("\n"));

  try {
    const result = await generateText({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 500,
    });

    const text = result.text.trim();
    if (!text || text === "[]") return null;

    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(
        (s: unknown): s is Suggestion =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as Suggestion).commandId === "string" &&
          typeof (s as Suggestion).name === "string",
      )
      .slice(0, 3);
  } catch {
    return null;
  }
}
