import { existsSync } from "node:fs";
import path from "node:path";

// `import.meta.dirname` here is whichever output file esbuild inlines this
// module into (each entry/chunk carries its own location), so it is only used
// as a starting point for the marker-based walk-up below — never as a fixed
// offset to other runtime files.
const moduleDir = import.meta.dirname;

let cachedRoot: string | null = null;

/**
 * Repo root that contains the `runtime/` source tree.
 *
 * Prefers `STELLA_APP_DIR` (set in the Electron main process and inherited by
 * spawned sidecar children); falls back to walking up from this module until a
 * `package.json` + `runtime/` marker is found so vitest and any child without
 * the env still resolve. Stella runs from its source tree, so source-tree
 * assets always live under `<root>/runtime/...`.
 */
export function getStellaAppDir(): string {
  if (cachedRoot) return cachedRoot;

  const fromEnv = process.env.STELLA_APP_DIR?.trim();
  if (fromEnv) {
    cachedRoot = fromEnv;
    return cachedRoot;
  }

  let dir = moduleDir;
  for (let i = 0; i < 16; i += 1) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "runtime"))
    ) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: assume the canonical source layout
  // (<root>/runtime/kernel/shared -> <root>).
  cachedRoot = path.resolve(moduleDir, "..", "..", "..");
  return cachedRoot;
}

/**
 * Resolve a data asset that ships in the repo's source tree under `runtime/`
 * (e.g. the OAuth catalog JSON, bundled agent markdown). The STELLA_APP_DIR path
 * is canonical; the dev-build copy under `desktop/dist-electron/` is a fallback
 * for callers that only see the bundled tree.
 */
export function resolveRuntimeSourceAsset(...segments: string[]): string {
  const root = getStellaAppDir();
  const candidates = [
    path.join(root, ...segments),
    path.join(root, "desktop", "dist-electron", ...segments),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Resolve a compiled runtime file that lives under the bundled
 * `desktop/dist-electron/runtime/` tree (worker entry, sidecar CLIs, the
 * deferred-delete helper). Anchored on STELLA_APP_DIR rather than this module's
 * `import.meta` — esbuild inlines shared modules into each entry/chunk, so a
 * shared helper's own location is not a stable offset to sibling files. The
 * `.ts` source candidate keeps vitest (which runs the un-bundled tree) working.
 *
 * @param relativeToRuntimeRoot e.g. "worker/entry.js" or "kernel/cli/foo.js"
 */
export function resolveBundledRuntimeFile(relativeToRuntimeRoot: string): string {
  const root = getStellaAppDir();
  const segments = relativeToRuntimeRoot.replace(/\\/g, "/").split("/");
  const sourceSegments = segments.map((segment, index) =>
    index === segments.length - 1 ? segment.replace(/\.js$/, ".ts") : segment,
  );
  const candidates = [
    path.join(root, "desktop", "dist-electron", "runtime", ...segments),
    path.join(root, "runtime", ...sourceSegments),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
