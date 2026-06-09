/**
 * Pre-warms Vite's dependency-optimizer cache (`node_modules/.vite`) so the
 * first real launch skips the cold prebundle — the single biggest first-launch
 * line item on slow machines (mermaid alone is ~75MB of input; see
 * `optimizeDeps.include` in `desktop/vite.config.ts`).
 *
 * This must run on the user's machine (launcher install step), not in CI:
 * Vite's dep hash covers `config.root` and the absolute react alias paths
 * (see `getConfigHash`), so a cache baked at a CI workspace path is discarded
 * as stale once the tree lands in `~/stella`.
 *
 * Idempotent: when the cache is already fresh for the current lockfile +
 * config, Vite returns the cached metadata without rebundling.
 */
import path from "node:path";

const scriptDir = import.meta.dirname;
const desktopDir = path.resolve(scriptDir, "..");

// Match the dev server's env so the dep hash (which folds in NODE_ENV/mode)
// lines up with what `electron:dev` resolves at launch.
process.env.NODE_ENV = "development";

try {
  const { createLogger, resolveConfig, optimizeDeps } = await import("vite");
  const logger = createLogger("warn");
  const baseWarn = logger.warn.bind(logger);
  logger.warn = (msg, options) => {
    // Direct optimizeDeps calls are deprecated for app dev servers, but this
    // script exists precisely to run the optimizer ahead of time.
    if (typeof msg === "string" && msg.includes("optimizeDeps is deprecated")) {
      return;
    }
    baseWarn(msg, options);
  };
  const config = await resolveConfig(
    {
      configFile: path.join(desktopDir, "vite.config.ts"),
      root: desktopDir,
      customLogger: logger,
    },
    "serve",
    "development",
    "development",
  );
  const startedAt = Date.now();
  await optimizeDeps(config);
  console.log(
    `[prewarm-vite-deps] dependency cache ready in ${Date.now() - startedAt}ms`,
  );
} catch (error) {
  // Purely an optimization: a failed prewarm just means the first launch pays
  // the cold prebundle like before.
  console.warn(
    `[prewarm-vite-deps] failed (first launch will prebundle instead): ${error instanceof Error ? error.message : String(error)}`,
  );
}
