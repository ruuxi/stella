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
 * Build a cache-busting query suffix for ESM `import()` so the runtime
 * picks up edits to existing extension files on F1 reload.
 *
 * The Node ESM loader caches modules by their full specifier string. A
 * stable `file:///abs/path.ts` URL hits the cache on every reload —
 * even if the file was edited on disk — and `import()` returns the
 * old module record. Appending a query that changes between calls
 * (file mtime + a per-load token) makes each reload's specifier
 * unique while keeping intra-load deduplication intact (two
 * `importModules` invocations during the same `loadExtensions` call
 * share the same loadToken so they don't re-import the same file).
 *
 * Using mtime alone wouldn't help if the user saved twice within the
 * same millisecond; `loadToken` provides a tiebreaker. Querystrings
 * are valid in `file://` URLs and the loader treats different
 * query-stringed specifiers as distinct cache keys.
 *
 * Note: this DOES leak the previous version's module record from the
 * loader cache on every reload — Node ESM exposes no public API to
 * evict a module by URL. Per-session leak ≈ N × (file count under
 * `extensions/**`) where N is the number of reloads. For typical
 * extension authoring (occasional edits, a handful of files) the
 * working set is small. For pathological churn (auto-reload on every
 * keystroke through a watcher, or thousands of files), expect the
 * worker process to grow until restart.
 *
 * Mitigation: {@link loadExtensions} logs a heads-up when the per-
 * worker reload count crosses a threshold so the user has a signal
 * to restart Stella before memory becomes a problem. Bumping the
 * threshold here is fine — the trade-off is "surface a warning the
 * user might care about" vs. "let the leak grow silently."
 */
const cacheBuster = async (
  filePath: string,
  loadToken: string,
): Promise<string> => {
  let mtime = 0;
  try {
    const stat = await fs.stat(filePath);
    mtime = stat.mtimeMs;
  } catch {
    // Falling back to loadToken alone keeps the cache-bust correct
    // even if stat fails for some reason.
  }
  return `?v=${mtime}-${loadToken}`;
};

/**
 * Dynamically import all matching TypeScript files from a directory.
 * Returns the default export of each file.
 */
async function importModules<T>(
  dir: string,
  suffix: string,
  loadToken: string,
): Promise<T[]> {
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
      // Use file:// URL for cross-platform ESM import compatibility,
      // with a cache-busting query string so F1 reload picks up edits.
      const resolvedPath = path.resolve(filePath);
      const fileUrl =
        `file:///${resolvedPath.replace(/\\/g, "/")}` +
        (await cacheBuster(filePath, loadToken));
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

async function loadExtensionFactories(
  baseDir: string,
  loadToken: string,
): Promise<LoadedExtensions> {
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
      const fileUrl =
        `file:///${resolvedPath.replace(/\\/g, "/")}` +
        (await cacheBuster(filePath, loadToken));
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
// Per-process counter of how many times `loadExtensions` has run.
// First call (startup) is 1; each F1 reload increments it. Used only
// to surface a warning when the count crosses
// `LOADER_RELOAD_WARN_THRESHOLD` so the user has a signal that the
// ESM-loader cache is accumulating stale module records (see
// `cacheBuster` for why eviction isn't possible).
let loadExtensionsCallCount = 0;
const LOADER_RELOAD_WARN_THRESHOLD = 50;

export async function loadExtensions(baseDir: string): Promise<LoadedExtensions> {
  loadExtensionsCallCount += 1;
  if (loadExtensionsCallCount === LOADER_RELOAD_WARN_THRESHOLD) {
    // One-shot warning at the threshold. Silent past that — repeated
    // warnings would drown out other logs and the user already has
    // the signal.
    log(
      `Extensions have been (re)loaded ${loadExtensionsCallCount} times this session. ` +
        "Each reload leaks the previous version's module records into the Node ESM loader cache. " +
        "If you're seeing memory pressure, restart Stella to clear the cache.",
    );
  }
  log(`Loading extensions from ${baseDir}`);

  // Per-load token shared across all importModules calls below so a
  // single `loadExtensions` invocation reuses cached imports for the
  // same file, but a subsequent reload (next call to `loadExtensions`)
  // sees a fresh token and re-imports edited files. See `cacheBuster`.
  const loadToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [tools, hooks, providers, prompts, registered] = await Promise.all([
    importModules<ToolDefinition>(
      path.join(baseDir, "tools"),
      ".tool.ts",
      loadToken,
    ),
    importModules<HookDefinition>(
      path.join(baseDir, "hooks"),
      ".hook.ts",
      loadToken,
    ),
    importModules<ProviderDefinition>(
      path.join(baseDir, "providers"),
      ".provider.ts",
      loadToken,
    ),
    loadPrompts(path.join(baseDir, "prompts")),
    loadExtensionFactories(baseDir, loadToken),
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
