/**
 * Extension loader - auto-discovers tools, hooks, providers, and prompts
 * from the agents directory structure.
 */

import { promises as fs } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import type {
  ToolDefinition,
  HookDefinition,
  ProviderDefinition,
  PromptTemplate,
  LoadedExtensions,
} from "./types.js";

const log = (...args: unknown[]) => console.log("[stella:extensions]", ...args);
const logError = (...args: unknown[]) => console.error("[stella:extensions]", ...args);

/**
 * Dynamically import all matching TypeScript files from a directory.
 * Returns the default export of each file.
 */
async function importModules<T>(dir: string, suffix: string): Promise<T[]> {
  const results: T[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const filePath = path.join(dir, entry);
    try {
      // Use file:// URL for cross-platform ESM import compatibility
      const fileUrl = `file:///${filePath.replace(/\\/g, "/")}`;
      const mod = await import(/* @vite-ignore */ fileUrl);
      const definition = mod.default ?? mod;
      if (definition && typeof definition === "object") {
        results.push(definition as T);
        log(`Loaded ${suffix}: ${entry}`);
      }
    } catch (error) {
      logError(`Failed to load ${filePath}:`, (error as Error).message);
    }
  }

  return results;
}

/**
 * Parse prompt template markdown files with optional frontmatter.
 */
async function loadPrompts(dir: string): Promise<PromptTemplate[]> {
  const results: PromptTemplate[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".prompt.md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const { metadata, body } = extractFrontmatter(raw);
      const baseName = entry.replace(/\.prompt\.md$/, "");
      results.push({
        name: typeof metadata.name === "string" ? metadata.name : baseName,
        description: typeof metadata.description === "string" ? metadata.description : "",
        template: body.trim() || raw,
        filePath,
      });
      log(`Loaded prompt: ${entry}`);
    } catch (error) {
      logError(`Failed to load prompt ${filePath}:`, (error as Error).message);
    }
  }

  return results;
}

const FRONTMATTER_DELIM = "---";

function extractFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  if (!content.startsWith(FRONTMATTER_DELIM)) {
    return { metadata: {}, body: content };
  }

  const lines = content.split("\n");
  if (lines.length < 3) {
    return { metadata: {}, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_DELIM) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { metadata: {}, body: content };
  }

  const frontmatterText = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");

  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed && typeof parsed === "object") {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Fall through
  }

  return { metadata: {}, body };
}

/**
 * Load all extensions from an agents directory.
 *
 * Expected structure:
 *   baseDir/
 *     tools/*.tool.ts
 *     hooks/*.hook.ts
 *     providers/*.provider.ts
 *     prompts/*.prompt.md
 */
export async function loadExtensions(baseDir: string): Promise<LoadedExtensions> {
  log(`Loading extensions from ${baseDir}`);

  const [tools, hooks, providers, prompts] = await Promise.all([
    importModules<ToolDefinition>(path.join(baseDir, "tools"), ".tool.ts"),
    importModules<HookDefinition>(path.join(baseDir, "hooks"), ".hook.ts"),
    importModules<ProviderDefinition>(path.join(baseDir, "providers"), ".provider.ts"),
    loadPrompts(path.join(baseDir, "prompts")),
  ]);

  log(`Loaded ${tools.length} tools, ${hooks.length} hooks, ${providers.length} providers, ${prompts.length} prompts`);

  return { tools, hooks, providers, prompts };
}
