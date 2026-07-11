/**
 * Electron-main / preload / worker / CLI bundle builds.
 *
 * Historically this script kept four esbuild watch contexts (plus the esbuild
 * service process) resident for the whole app session — ~200MB of steady-state
 * memory paid purely so rarely-changing host bundles could rebuild on source
 * change. It now builds on demand instead:
 *
 *   - One-shot builds via the esbuild API, with `write: false` + manual
 *     write-if-changed so byte-identical outputs never touch disk. That gate
 *     matters: the host's dist watcher (`startDevWatcher` in
 *     `runtime/host/index.ts`) restarts the worker on any mtime bump under
 *     `dist-electron/runtime/`, so rewriting unchanged worker bundles when
 *     only electron-main changed would cold-respawn the worker for nothing.
 *   - `esbuild.stop()` after every build so the service process exits instead
 *     of idling resident.
 *   - A bare `fs.watch` over the source roots (native fs events, ~0 cost)
 *     drives debounced rebuilds while the app runs — self-mod runs and manual
 *     user edits both land through it.
 *   - A stat fingerprint of the source roots persisted next to the outputs
 *     lets a warm launch skip the startup build entirely when nothing changed
 *     since the last successful build.
 *
 * Run directly (postinstall, low-resource build) it performs the historical
 * `--once` behavior: clean outdir, full build, exit.
 */
import { build as runEsbuildBuild, stop as stopEsbuildService } from "esbuild";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  watch as watchFs,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = import.meta.dirname;
const desktopDir = path.resolve(scriptDir, "..");
const repoRootDir = path.resolve(desktopDir, "..");
const outdir = "dist-electron";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const runtimeStaticAssetRoots = ["runtime/extensions/stella-runtime/agents"];
const electronRuntimeEntryPoints = [
  "desktop/electron/main.ts",
  "runtime/kernel/cli/stella-computer.ts",
  "runtime/kernel/cli/stella-connect.ts",
  "runtime/kernel/cli/stella-media.ts",
  "runtime/kernel/tools/deferred-delete-cli.ts",
];
// The worker builds on its own so we can code-split it: the heavy runner
// subgraph is lazily imported in server.ts, and splitting lands it in a
// separate chunk instead of inflating entry.js — so the worker reaches "ready"
// without parsing it. Kept apart from main/CLIs to limit splitting's blast
// radius to the worker.
const workerEntryPoints = ["runtime/worker/entry.ts"];
const preloadEntryPoints = ["desktop/electron/preload.ts"];
const storeWebPreloadEntryPoints = ["desktop/electron/store-web-preload.ts"];

const fingerprintFilePath = path.join(
  desktopDir,
  ".dev-electron-bundle-fingerprint.json",
);

/**
 * Everything the four bundles can pull in. `desktop/src/shared/` is included
 * because electron-main/preload import contracts and lib shims from there
 * (see e.g. `desktop/electron/preload.ts`). `runtime/home-seed/` is seed
 * data, never bundled, and excluded so seeding churn doesn't trigger builds.
 */
const bundleSourceRoots = [
  "desktop/electron",
  "desktop/src/shared",
  "runtime",
];
const bundleSourceExcludedPrefixes = ["runtime/home-seed/"];
const bundleConfigFiles = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "desktop/tsconfig.json",
  "desktop/tsconfig.electron.json",
  "desktop/tsconfig.preload.json",
];
const bundleSourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);

const toPosix = (value) => value.split(path.sep).join("/");

const isBundleSourceRelPath = (relPosixPath) => {
  if (bundleSourceExcludedPrefixes.some((p) => relPosixPath.startsWith(p))) {
    return false;
  }
  return bundleSourceExtensions.has(path.posix.extname(relPosixPath));
};

const createBuildOptions = () => [
  {
    absWorkingDir: repoRootDir,
    bundle: true,
    entryPoints: electronRuntimeEntryPoints,
    external: ["electron"],
    format: "esm",
    logLevel: "warning",
    outbase: ".",
    outdir: path.join("desktop", outdir),
    packages: "external",
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("desktop", "tsconfig.electron.json"),
  },
  {
    absWorkingDir: repoRootDir,
    bundle: true,
    entryPoints: workerEntryPoints,
    external: ["electron"],
    format: "esm",
    // Split the lazily-imported runner subgraph into its own chunk(s). Chunks
    // sit next to entry.js (under runtime/worker/chunks/) so Bun resolves them
    // relatively at runtime; entry.js stays at its existing path.
    splitting: true,
    chunkNames: "runtime/worker/chunks/[name]-[hash]",
    // Consumed by assertWorkerBundleBoundary after each build.
    metafile: true,
    logLevel: "warning",
    outbase: ".",
    outdir: path.join("desktop", outdir),
    packages: "external",
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("desktop", "tsconfig.electron.json"),
  },
  {
    absWorkingDir: repoRootDir,
    bundle: true,
    external: ["electron"],
    entryPoints: preloadEntryPoints,
    format: "cjs",
    logLevel: "warning",
    outbase: ".",
    outdir: path.join("desktop", outdir),
    packages: "external",
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("desktop", "tsconfig.preload.json"),
  },
  {
    absWorkingDir: repoRootDir,
    bundle: true,
    external: ["electron"],
    entryPoints: storeWebPreloadEntryPoints,
    format: "esm",
    logLevel: "warning",
    outbase: ".",
    outdir: path.join("desktop", outdir),
    packages: "external",
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("desktop", "tsconfig.preload.json"),
  },
];

/**
 * Modules that must never reach the worker bundle. The worker runs under
 * Bun, detached from Electron; these modules are Electron-main-owned (home
 * seeding, remote prompt sync + its sqlite update lock). In desktop-v0.0.409
 * a static `node:sqlite` import leaked in through this exact path — worker
 * tools imported path helpers from `stella-home.ts`, which statically drags
 * in the whole sync graph — and every new worker crashed on runner load
 * while its socket still looked healthy. Worker code needing path helpers
 * imports `runtime/kernel/home/stella-paths.ts` instead.
 */
const workerBannedInputs = [
  "runtime/kernel/home/stella-home.ts",
  "runtime/kernel/home/prompt-manifest-sync.ts",
  "runtime/kernel/home/skills-sync.ts",
  "runtime/kernel/home/agents-sync.ts",
];
const workerBannedInputPrefixes = ["desktop/electron/"];

const assertWorkerBundleBoundary = (metafile) => {
  const inputs = Object.keys(metafile?.inputs ?? {}).map((input) =>
    toPosix(input),
  );
  const violations = inputs.filter(
    (input) =>
      workerBannedInputs.includes(input) ||
      workerBannedInputPrefixes.some((prefix) => input.startsWith(prefix)),
  );
  if (violations.length > 0) {
    throw new Error(
      `Electron-only module(s) bundled into the Bun worker: ${violations.join(", ")}. ` +
        "Import pure path helpers from runtime/kernel/home/stella-paths.ts instead of " +
        "stella-home.ts, or move the shared code into a runtime-safe module.",
    );
  }
};

const writeOutputIfChanged = (absPath, contents) => {
  try {
    const existing = readFileSync(absPath);
    if (existing.length === contents.length && existing.equals(contents)) {
      return false;
    }
  } catch {
    // Missing file — fall through to the write.
  }
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents);
  return true;
};

const copyRuntimeStaticAssets = async () => {
  await Promise.all(
    runtimeStaticAssetRoots.map(async (rootRelativePath) => {
      const sourceDir = path.join(repoRootDir, rootRelativePath);
      const targetDir = path.join(desktopDir, outdir, rootRelativePath);
      try {
        await fsPromises.rm(targetDir, {
          force: true,
          recursive: true,
        });
        await fsPromises.cp(sourceDir, targetDir, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }),
  );
};

/**
 * One-shot build of all four bundles. Outputs are produced with
 * `write: false` and written manually only when their bytes differ from
 * what's on disk, so downstream watchers (Electron restart gate, host worker
 * watcher) only ever see genuine changes. The esbuild service process is
 * stopped afterwards so nothing stays resident between builds.
 */
export const buildElectronBundles = async () => {
  try {
    const optionsList = createBuildOptions();
    const results = await Promise.all(
      optionsList.map((options) => runEsbuildBuild({ ...options, write: false })),
    );
    const workerResult = results[
      optionsList.findIndex((options) => options.entryPoints === workerEntryPoints)
    ];
    assertWorkerBundleBoundary(workerResult.metafile);
    const changedOutputs = [];
    for (const result of results) {
      for (const file of result.outputFiles ?? []) {
        if (writeOutputIfChanged(file.path, file.contents)) {
          changedOutputs.push(file.path);
        }
      }
    }
    await copyRuntimeStaticAssets();
    return changedOutputs;
  } finally {
    await stopEsbuildService();
  }
};

const collectBundleSourceFiles = () => {
  const files = [];

  const visit = (absolutePath) => {
    let entries;
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = path.join(absolutePath, entry.name);
      const relPosixPath = toPosix(path.relative(repoRootDir, childPath));
      if (entry.isDirectory()) {
        if (
          !bundleSourceExcludedPrefixes.some((p) =>
            `${relPosixPath}/`.startsWith(p),
          )
        ) {
          visit(childPath);
        }
        continue;
      }
      if (entry.isFile() && isBundleSourceRelPath(relPosixPath)) {
        files.push(relPosixPath);
      }
    }
  };

  for (const root of bundleSourceRoots) {
    visit(path.join(repoRootDir, root));
  }
  for (const configFile of bundleConfigFiles) {
    if (existsSync(path.join(repoRootDir, configFile))) {
      files.push(toPosix(configFile));
    }
  }

  files.sort();
  return files;
};

export const computeBundleInputsFingerprint = () => {
  const hash = createHash("sha256");
  for (const relPath of collectBundleSourceFiles()) {
    let stat;
    try {
      stat = lstatSync(path.join(repoRootDir, relPath));
    } catch {
      continue;
    }
    hash.update(relPath);
    hash.update("\0");
    hash.update(String(stat.size));
    hash.update("\0");
    hash.update(String(stat.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const readBundleFingerprint = () => {
  try {
    const parsed = JSON.parse(readFileSync(fingerprintFilePath, "utf8"));
    return typeof parsed?.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
};

const writeBundleFingerprint = (fingerprint) => {
  try {
    writeFileSync(
      fingerprintFilePath,
      JSON.stringify(
        { fingerprint, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch {
    // Best-effort; a missing fingerprint just means the next launch rebuilds.
  }
};

export const requiredOutputsExist = () => {
  const outBase = path.join(desktopDir, outdir, "desktop", "electron");
  return (
    existsSync(path.join(outBase, "main.js")) &&
    existsSync(path.join(outBase, "preload.js"))
  );
};

export const cleanOutdir = async () => {
  await fsPromises.rm(path.join(desktopDir, outdir), {
    force: true,
    recursive: true,
  });
};

/**
 * Startup path: skip the build entirely when the outputs exist and the source
 * fingerprint matches the last successful build (the common warm launch).
 * A missing-output cold start cleans the outdir first for a deterministic
 * from-scratch build; a stale fingerprint rebuilds in place and relies on the
 * write-if-changed gate to keep untouched outputs byte-stable.
 */
export const ensureElectronBundlesFresh = async ({ log } = {}) => {
  const fingerprint = computeBundleInputsFingerprint();
  if (requiredOutputsExist() && readBundleFingerprint() === fingerprint) {
    log?.("electron bundles are current; skipping startup build.");
    return { built: false };
  }
  if (!requiredOutputsExist()) {
    await cleanOutdir();
  }
  log?.("electron bundle inputs changed; rebuilding.");
  await buildElectronBundles();
  writeBundleFingerprint(computeBundleInputsFingerprint());
  return { built: true };
};

/**
 * Watches the bundle source roots with bare fs.watch and runs debounced
 * one-shot rebuilds. Returns a close() handle. Build failures are logged and
 * leave the persisted fingerprint stale so the next launch rebuilds.
 */
export const watchElectronBundleSources = ({
  debounceMs = 300,
  log,
  logError,
} = {}) => {
  const watchers = [];
  let closed = false;
  let debounceTimer = null;
  let buildChain = Promise.resolve();

  const scheduleBuild = () => {
    if (closed) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      buildChain = buildChain
        .catch(() => undefined)
        .then(async () => {
          if (closed) {
            return;
          }
          const startedAt = Date.now();
          try {
            const changedOutputs = await buildElectronBundles();
            writeBundleFingerprint(computeBundleInputsFingerprint());
            log?.(
              `rebuilt electron bundles in ${Date.now() - startedAt}ms (${changedOutputs.length} output${changedOutputs.length === 1 ? "" : "s"} changed)`,
            );
          } catch (error) {
            logError?.(
              `electron bundle rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        });
    }, debounceMs);
  };

  for (const root of bundleSourceRoots) {
    const absoluteRoot = path.join(repoRootDir, root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    const watcher = watchFs(
      absoluteRoot,
      { recursive: true },
      (_eventType, filename) => {
        if (typeof filename !== "string") {
          return;
        }
        const relPosixPath = path.posix.join(toPosix(root), toPosix(filename));
        if (!isBundleSourceRelPath(relPosixPath)) {
          return;
        }
        scheduleBuild();
      },
    );
    watchers.push(watcher);
  }

  return {
    close: async () => {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
      await buildChain.catch(() => undefined);
    },
  };
};

const isRunDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  // Historical `--once` behavior (postinstall, low-resource build): clean
  // outdir, deterministic from-scratch build, exit. The flag is accepted for
  // existing callers but one-shot is now the only direct-invocation mode.
  try {
    await cleanOutdir();
    await buildElectronBundles();
    writeBundleFingerprint(computeBundleInputsFingerprint());
    process.exit(0);
  } catch (error) {
    console.error(
      `[electron-build] Build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
