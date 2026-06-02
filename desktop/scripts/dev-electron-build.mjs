import {
  build as runEsbuildBuild,
  context as createEsbuildContext,
} from "esbuild";
import { existsSync, promises as fsPromises, watch as watchFs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRootDir = path.resolve(desktopDir, "..");
const outdir = "dist-electron";
const buildOnce = process.argv.includes("--once");
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const runtimeStaticAssetRoots = [
  "runtime/extensions/stella-runtime/agents",
  "runtime/extensions/stella-runtime/personality",
];
const electronRuntimeEntryPoints = [
  "desktop/electron/main.ts",
  "runtime/worker/entry.ts",
  "runtime/kernel/cli/stella-computer.ts",
  "runtime/kernel/cli/stella-connect.ts",
  "runtime/kernel/cli/stella-media.ts",
  "runtime/kernel/tools/deferred-delete-cli.ts",
];
const preloadEntryPoints = ["desktop/electron/preload.ts"];
const storeWebPreloadEntryPoints = ["desktop/electron/store-web-preload.ts"];

let buildContexts = [];
let rebuildChain = Promise.resolve();
let shuttingDown = false;
const assetWatchers = [];
const runnerPid = Number.parseInt(
  process.env.STELLA_ELECTRON_DEV_RUNNER_PID ?? "",
  10,
);
const parentPidToWatch =
  Number.isFinite(runnerPid) && runnerPid > 1 ? runnerPid : process.ppid;
let parentWatchTimer = null;

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const createBuildOptions = () => [
  {
    absWorkingDir: repoRootDir,
    bundle: true,
    entryPoints: electronRuntimeEntryPoints,
    external: ["electron"],
    format: "esm",
    logLevel: "info",
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
    logLevel: "info",
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
    logLevel: "info",
    outbase: ".",
    outdir: path.join("desktop", outdir),
    packages: "external",
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("desktop", "tsconfig.preload.json"),
  },
];

const startBuildContexts = async () => {
  const contexts = await Promise.all(
    createBuildOptions().map((options) => createEsbuildContext(options)),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  return contexts;
};

const runOneShotBuild = async () => {
  await Promise.all(
    createBuildOptions().map((options) => runEsbuildBuild(options)),
  );
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

const disposeBuildContexts = async () => {
  const contextsToDispose = buildContexts;
  buildContexts = [];
  await Promise.all(contextsToDispose.map((ctx) => ctx.dispose()));
};

const scheduleAssetCopy = () => {
  if (shuttingDown) {
    return;
  }
  rebuildChain = rebuildChain
    .catch(() => undefined)
    .then(async () => {
      await copyRuntimeStaticAssets();
    });
};

const startAssetWatchers = () => {
  for (const root of runtimeStaticAssetRoots) {
    const absoluteRoot = path.join(repoRootDir, root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    const watcher = watchFs(
      absoluteRoot,
      { recursive: true },
      (eventType, filename) => {
        if (eventType !== "rename" || typeof filename !== "string") {
          return;
        }
        if (filename.endsWith(".md")) {
          scheduleAssetCopy();
        }
      },
    );
    assetWatchers.push(watcher);
  }
};

const cleanOutdir = async () => {
  await fsPromises.rm(path.join(desktopDir, outdir), {
    force: true,
    recursive: true,
  });
};

const shutdown = async (exitCode) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (parentWatchTimer) {
    clearInterval(parentWatchTimer);
    parentWatchTimer = null;
  }

  for (const watcher of assetWatchers) {
    watcher.close();
  }

  await rebuildChain.catch(() => undefined);
  await disposeBuildContexts();
  process.exit(exitCode);
};

try {
  await cleanOutdir();
  if (buildOnce) {
    await runOneShotBuild();
    await copyRuntimeStaticAssets();
    process.exit(0);
  }
  buildContexts = await startBuildContexts();
  await copyRuntimeStaticAssets();
  startAssetWatchers();
} catch (error) {
  console.error(
    `[electron-build] Failed to start electron build watchers: ${error instanceof Error ? error.message : String(error)}`,
  );
  await shutdown(1);
}

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(143);
});

process.once("SIGHUP", () => {
  void shutdown(129);
});

parentWatchTimer = setInterval(() => {
  if (parentPidToWatch > 1 && !isPidAlive(parentPidToWatch)) {
    void shutdown(0);
  }
}, 1_000);
parentWatchTimer.unref?.();

await new Promise(() => {});
