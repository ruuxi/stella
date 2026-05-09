import path from "node:path";

/**
 * Shared path filters used by the worker and Vite overlay plugin to classify
 * self-mod writes. Centralizing this avoids the worker and plugin disagreeing
 * on which paths are renderer-HMR-able versus restart-required.
 *
 * Classes answered here:
 *   - renderer HMR paths: Vite-loadable renderer modules that can be applied
 *     through the overlay load() hook.
 *   - full-window reload paths: Vite-served browser resources that need a
 *     browser reload rather than targeted module HMR.
 *   - worker restart paths: runtime worker code that the dist-electron watcher
 *     restarts after the self-mod pause releases.
 *   - restart-required/non-HMR paths: configs/manifests/backends that cannot be
 *     made visible by the Vite overlay or a browser reload.
 *
 * Inputs are normalized to repo-relative forward-slash paths via
 * `normalizeContentionPath` so callers don't have to care about absolute
 * vs relative or platform separators.
 */

const POSIX_SEP = "/";

const EXCLUDED_PATH_SEGMENTS = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  ".bun",
  ".cache",
  ".vite",
  ".turbo",
  ".next",
  "build",
  "coverage",
  "out",
  ".stella-state",
]);

const EXCLUDED_FILE_SUFFIXES: ReadonlyArray<string> = [
  // Image / media
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".ico",
  ".heic",
  ".svg",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  // Documents / spreadsheets / archives
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".tsv",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  ".pages",
  ".numbers",
  ".key",
  ".epub",
  ".mobi",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  // Build / lockfile / runtime artifacts
  ".lockb",
  ".log",
  ".map",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".db-wal",
  ".db-shm",
  ".pdb",
  ".so",
  ".dylib",
  ".dll",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
];

const RENDERER_HMR_PREFIXES: ReadonlyArray<string> = [
  "desktop/src/",
];

const RENDERER_TEXT_ASSET_SUFFIXES = new Set<string>([
  ".svg",
]);

const FULL_WINDOW_RELOAD_FILES = new Set<string>([
  "desktop/index.html",
]);

const SIDEBAR_APP_METADATA_RE = /^desktop\/src\/app\/[^/]+\/metadata\.ts$/;

/**
 * Top-level files (no directory prefix) that still count as relevant —
 * config / manifests that affect the app, but are not renderer-HMR-able.
 */
const CONTENTION_TOP_LEVEL_FILES = new Set<string>([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.base.json",
]);

const RESTART_REQUIRED_MANIFEST_BASENAMES = new Set<string>([
  ...CONTENTION_TOP_LEVEL_FILES,
  "npm-shrinkwrap.json",
]);

const RUNTIME_KERNEL_HOST_OWNED_PREFIXES: ReadonlyArray<string> = [
  "runtime/kernel/convex-urls",
  "runtime/kernel/dev-projects/",
  "runtime/kernel/home/",
  "runtime/kernel/local-scheduler-service",
  "runtime/kernel/preferences/local-preferences",
  "runtime/kernel/shared/",
  "runtime/kernel/storage/",
  "runtime/kernel/tools/network-guards",
  "runtime/kernel/tools/stella-browser-bridge-config",
];

const toPosix = (value: string): string => value.replace(/\\/g, POSIX_SEP);

const stripTrailingSlash = (value: string): string =>
  value.endsWith(POSIX_SEP) ? value.slice(0, -1) : value;

const basename = (repoRelativePath: string): string => {
  const normalized = stripTrailingSlash(toPosix(repoRelativePath));
  const idx = normalized.lastIndexOf(POSIX_SEP);
  return idx === -1 ? normalized : normalized.slice(idx + 1);
};

const isRestartRequiredManifestPath = (repoRelativePath: string): boolean =>
  RESTART_REQUIRED_MANIFEST_BASENAMES.has(basename(repoRelativePath));

const isRendererTextAssetPath = (repoRelativePath: string): boolean => {
  if (!isRendererHmrRelevantPath(repoRelativePath)) return false;
  const normalized = stripTrailingSlash(toPosix(repoRelativePath)).toLowerCase();
  for (const suffix of RENDERER_TEXT_ASSET_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true;
  }
  return false;
};

/**
 * Returns the repo-relative forward-slash path if `absPath` is inside
 * `repoRoot` and not in an excluded segment / not a known artifact
 * extension. Returns `null` otherwise.
 *
 * Both inputs are tolerated as either platform-native or already-posix:
 * we normalize via Node `path` and then to posix separators.
 */
export const normalizeContentionPath = (
  absPath: string,
  repoRoot: string,
): string | null => {
  if (typeof absPath !== "string" || absPath.length === 0) return null;
  if (typeof repoRoot !== "string" || repoRoot.length === 0) return null;

  const normalizedAbs = path.resolve(absPath);
  const normalizedRoot = path.resolve(repoRoot);
  const relative = path.relative(normalizedRoot, normalizedAbs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const posix = toPosix(relative);
  if (posix.length === 0 || posix === ".") return null;

  if (!posix.includes(POSIX_SEP) && CONTENTION_TOP_LEVEL_FILES.has(posix)) {
    return posix;
  }

  for (const segment of posix.split(POSIX_SEP)) {
    if (EXCLUDED_PATH_SEGMENTS.has(segment)) return null;
  }

  if (isRestartRequiredManifestPath(posix)) {
    return posix;
  }

  if (isRendererTextAssetPath(posix)) {
    return posix;
  }

  const lower = posix.toLowerCase();
  for (const suffix of EXCLUDED_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return null;
  }
  return posix;
};

/**
 * True for repo-relative posix paths that can be served by the Vite overlay
 * load() hook and therefore should participate in renderer HMR contention.
 */
export const isRendererHmrRelevantPath = (repoRelativePath: string): boolean => {
  if (!repoRelativePath || repoRelativePath.startsWith("/")) return false;
  const normalized = stripTrailingSlash(toPosix(repoRelativePath));
  for (const prefix of RENDERER_HMR_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
};

export const isContentionRelevantPath = isRendererHmrRelevantPath;

/**
 * True for paths the Vite self-mod plugin can pin and later serve from the
 * overlay. This is narrower than the full self-mod relevance set: Vite cannot
 * make package installs, Electron main-process code, backend code, or its own
 * config visible by returning alternate module text from load().
 */
export const isViteTrackablePath = (repoRelativePath: string): boolean =>
  isRendererHmrRelevantPath(repoRelativePath) ||
  isFullWindowReloadRelevantPath(repoRelativePath);

/**
 * True for repo-relative posix paths whose change should trigger a
 * worker (Electron runtime) restart. Mirrors the rules used by the
 * dist-electron file watcher in runtime/client/index.ts.
 */
export const isWorkerRestartRelevantPath = (repoRelativePath: string): boolean => {
  if (!repoRelativePath) return false;
  const normalized = toPosix(repoRelativePath);

  if (
    normalized.startsWith("runtime/discovery/") &&
    !normalized.startsWith("runtime/discovery/browser-data")
  ) {
    return true;
  }
  if (
    normalized.startsWith("runtime/kernel/") &&
    !RUNTIME_KERNEL_HOST_OWNED_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  ) {
    return true;
  }
  if (
    normalized.startsWith("runtime/ai/") ||
    normalized.startsWith("runtime/worker/") ||
    normalized.startsWith("runtime/protocol/jsonl")
  ) {
    return true;
  }
  return false;
};

export const isRestartRelevantPath = isWorkerRestartRelevantPath;

/**
 * True for Vite-served browser resources that need a visible browser reload
 * instead of targeted module HMR. This intentionally excludes Vite config,
 * package manifests, and lockfiles: a browser reload cannot reload Vite config
 * or install dependencies.
 */
export const isFullWindowReloadRelevantPath = (repoRelativePath: string): boolean => {
  if (!repoRelativePath) return false;
  const normalized = stripTrailingSlash(toPosix(repoRelativePath));
  return (
    FULL_WINDOW_RELOAD_FILES.has(normalized) ||
    SIDEBAR_APP_METADATA_RE.test(normalized)
  );
};

export const isFullReloadRelevantPath = isFullWindowReloadRelevantPath;

export const isRestartRequiredNonHmrPath = (
  repoRelativePath: string,
): boolean => {
  if (!repoRelativePath) return false;
  const normalized = stripTrailingSlash(toPosix(repoRelativePath));
  if (!normalized.includes(POSIX_SEP)) {
    return CONTENTION_TOP_LEVEL_FILES.has(normalized);
  }
  return (
    isRestartRequiredManifestPath(normalized) ||
    normalized === "desktop/vite.config.ts" ||
    normalized.startsWith("desktop/electron/") ||
    normalized.startsWith("backend/") ||
    normalized.startsWith("launcher/") ||
    isWorkerRestartRelevantPath(normalized)
  );
};

export const isSelfModRelevantPath = (repoRelativePath: string): boolean =>
  isRendererHmrRelevantPath(repoRelativePath) ||
  isFullWindowReloadRelevantPath(repoRelativePath) ||
  isWorkerRestartRelevantPath(repoRelativePath) ||
  isRestartRequiredNonHmrPath(repoRelativePath);

/**
 * Helper that combines `normalizeContentionPath` + `isRendererHmrRelevantPath`,
 * for callers that have an absolute path and just want the repo-relative
 * key (or null to skip).
 */
export const toContentionKey = (
  absPath: string,
  repoRoot: string,
): string | null => {
  const normalized = normalizeContentionPath(absPath, repoRoot);
  if (!normalized) return null;
  return isRendererHmrRelevantPath(normalized) ? normalized : null;
};

export const toSelfModRelevantKey = (
  absPath: string,
  repoRoot: string,
): string | null => {
  const normalized = normalizeContentionPath(absPath, repoRoot);
  if (!normalized) return null;
  return isSelfModRelevantPath(normalized) ? normalized : null;
};
