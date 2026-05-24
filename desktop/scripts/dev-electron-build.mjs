import { context as createEsbuildContext } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, promises as fsPromises, watch as watchFs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRootDir = path.resolve(desktopDir, "..");
const outdir = "dist-electron";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const runtimeStaticAssetRoots = [
  "runtime/extensions/stella-runtime/agents",
  "runtime/extensions/stella-runtime/personality",
];
const preloadEntryPoints = ["desktop/electron/preload.ts"];
const storeWebPreloadEntryPoints = ["desktop/electron/store-web-preload.ts"];
const tsgoBinPath = path.resolve(
  repoRootDir,
  "node_modules",
  "@typescript",
  "native-preview",
  "bin",
  "tsgo.js",
);

let preloadBuildContexts = [];
let rebuildChain = Promise.resolve();
let shuttingDown = false;
const assetWatchers = [];
let electronTypeScriptWatcher = null;
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

const createPreloadBuildOptions = () => [
  {
    absWorkingDir: repoRootDir,
    bundle: true,
    external: ["electron"],
    entryPoints: preloadEntryPoints,
    format: "cjs",
    logLevel: "info",
    outbase: ".",
    outdir: path.join("desktop", outdir),
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
    platform: "node",
    target: nodeTarget,
    tsconfig: path.join("desktop", "tsconfig.preload.json"),
  },
];

const startPreloadBuildContexts = async () => {
  const contexts = await Promise.all(
    createPreloadBuildOptions().map((options) => createEsbuildContext(options)),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  return contexts;
};

const startElectronTypeScriptWatcher = () => {
  if (!existsSync(tsgoBinPath)) {
    console.error(
      `[electron-build] Missing tsgo binary at ${tsgoBinPath}. Run \`bun install\` at the repo root first.`,
    );
    process.exit(1);
  }

  const child = spawn(
    process.execPath,
    [
      tsgoBinPath,
      "-w",
      "-p",
      "tsconfig.electron.json",
      "--preserveWatchOutput",
    ],
    {
      cwd: desktopDir,
      env: { ...process.env },
      stdio: "inherit",
    },
  );
  electronTypeScriptWatcher = child;

  child.once("error", (error) => {
    electronTypeScriptWatcher = null;
    if (shuttingDown) {
      return;
    }
    console.error(
      `[electron-build] Electron TypeScript watcher failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    electronTypeScriptWatcher = null;
    if (shuttingDown) {
      return;
    }
    const detail = signal
      ? `exited via ${signal}`
      : `exited with code ${code ?? 0}`;
    console.error(
      `[electron-build] Electron TypeScript watcher ${detail}; stopping electron build.`,
    );
    process.exit(code && code !== 0 ? code : 1);
  });
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

const disposePreloadBuildContexts = async () => {
  const contextsToDispose = preloadBuildContexts;
  preloadBuildContexts = [];
  await Promise.all(contextsToDispose.map((ctx) => ctx.dispose()));
};

const stopElectronTypeScriptWatcher = async () => {
  const child = electronTypeScriptWatcher;
  if (!child) {
    return;
  }
  electronTypeScriptWatcher = null;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore races during shutdown.
      }
      resolvePromise();
    }, 3_000);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolvePromise();
    }
  });
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
  await stopElectronTypeScriptWatcher();
  await disposePreloadBuildContexts();
  process.exit(exitCode);
};

try {
  await cleanOutdir();
  preloadBuildContexts = await startPreloadBuildContexts();
  startElectronTypeScriptWatcher();
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
