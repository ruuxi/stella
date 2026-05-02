/**
 * Extension loader - auto-discovers tools, hooks, providers, prompts, and agents
 * from the extensions directory structure.
 */

import { promises as fs } from "fs";
import path from "path";
import type {
  ToolDefinition,
  HookDefinition,
  ProviderDefinition,
  PromptTemplate,
  LoadedExtensions,
  ExtensionFactory,
  ExtensionRegistrationApi,
} from "./types.js";
import { extractFrontmatter } from "../frontmatter.js";

const log = (...args: unknown[]) => console.error("[stella:extensions]", ...args);
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
      const resolvedPath = path.resolve(filePath);
      const fileUrl = `file:///${resolvedPath.replace(/\\/g, "/")}`;
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

async function loadExtensionFactories(baseDir: string): Promise<LoadedExtensions> {
  const collected: LoadedExtensions = {
    tools: [],
    hooks: [],
    providers: [],
    prompts: [],
    agents: [],
  };

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const extensionDir = path.join(baseDir, entry);
    let stat;
    try {
      stat = await fs.stat(extensionDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    const filePath = path.join(extensionDir, "index.ts");
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    try {
      const resolvedPath = path.resolve(filePath);
      const fileUrl = `file:///${resolvedPath.replace(/\\/g, "/")}`;
      const mod = await import(/* @vite-ignore */ fileUrl);
      const factory = (mod.default ?? mod) as ExtensionFactory;
      if (typeof factory !== "function") {
        continue;
      }

      const api: ExtensionRegistrationApi = {
        on(event, handler, filter) {
          collected.hooks.push({
            event,
            filter,
            handler,
          });
        },
        registerTool(tool) {
          collected.tools.push(tool);
        },
        registerProvider(provider) {
          collected.providers.push(provider);
        },
        registerPrompt(prompt) {
          collected.prompts.push(prompt);
        },
        registerAgent(agent) {
          collected.agents.push(agent);
        },
      };

      await factory(api);
      log(`Loaded extension: ${entry}`);
    } catch (error) {
      logError(`Failed to load extension ${filePath}:`, (error as Error).message);
    }
  }

  return collected;
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
        description:
          typeof metadata.description === "string" ? metadata.description : "",
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

/**
 * Load all extensions from an extensions directory.
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

  const [tools, hooks, providers, prompts, registered] = await Promise.all([
    importModules<ToolDefinition>(path.join(baseDir, "tools"), ".tool.ts"),
    importModules<HookDefinition>(path.join(baseDir, "hooks"), ".hook.ts"),
    importModules<ProviderDefinition>(path.join(baseDir, "providers"), ".provider.ts"),
    loadPrompts(path.join(baseDir, "prompts")),
    loadExtensionFactories(baseDir),
  ]);

  const loaded: LoadedExtensions = {
    tools: [...tools, ...registered.tools],
    hooks: [...hooks, ...registered.hooks],
    providers: [...providers, ...registered.providers],
    prompts: [...prompts, ...registered.prompts],
    agents: [...registered.agents],
  };

  log(
    `Loaded ${loaded.tools.length} tools, ${loaded.hooks.length} hooks, ${loaded.providers.length} providers, ${loaded.prompts.length} prompts, ${loaded.agents.length} agents`,
  );

  return loaded;
}
