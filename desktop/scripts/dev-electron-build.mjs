import { context as createEsbuildContext } from "esbuild";
import {
  existsSync,
  promises as fsPromises,
  watch as watchFs,
} from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const repoRootDir = path.resolve(projectDir, "..");
const outdir = "dist-electron";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const graphWatchRoots = [
  "desktop/electron",
  "runtime",
  "desktop/src/shared/contracts",
  "desktop/src/shared/ai",
  "desktop/src/shared",
  "desktop/src/convex",
  "desktop/src/prompts",
];
const mainEntryRoots = [
  "desktop/electron",
  "runtime",
  "desktop/src/shared/contracts",
  "desktop/src/shared/ai",
];
const mainExplicitEntries = [
  "desktop/src/convex/api.ts",
  "desktop/src/prompts/dashboard-page-focus.ts",
  "desktop/src/shared/lib/radial-trigger.ts",
  "desktop/src/shared/stella-api.ts",
];
const preloadEntryPoint = "desktop/electron/preload.ts";

let buildContexts = [];
let rebuildTimer = null;
let rebuildChain = Promise.resolve();
let shuttingDown = false;
const rootWatchers = [];

const normalizePath = (filePath) => filePath.split(path.sep).join("/");

const isTsSourceFile = (filePath) =>
  filePath.endsWith(".ts") &&
  !filePath.endsWith(".d.ts") &&
  !filePath.endsWith(".test.ts");

const collectTsEntries = async (rootRelativePath) => {
  const rootAbsolutePath = path.join(repoRootDir, rootRelativePath);
  const results = [];

  const visit = async (currentPath) => {
    let entries;
    try {
      entries = await fsPromises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile() || !isTsSourceFile(absolutePath)) {
        continue;
      }

      results.push(normalizePath(path.relative(repoRootDir, absolutePath)));
    }
  };

  await visit(rootAbsolutePath);
  return results;
};

const getMainEntryPoints = async () => {
  const collectedEntries = await Promise.all(
    mainEntryRoots.map((root) => collectTsEntries(root)),
  );
  const existingExplicitEntries = mainExplicitEntries.filter((entryPath) =>
    existsSync(path.join(repoRootDir, entryPath)),
  );
  const entryPoints = new Set(
    [...collectedEntries.flat(), ...existingExplicitEntries].map(normalizePath),
  );
  entryPoints.delete(normalizePath(preloadEntryPoint));
  return [...entryPoints].sort();
};

const createBuildOptions = async () => {
  const mainEntryPoints = await getMainEntryPoints();

  return [
    {
      absWorkingDir: repoRootDir,
      bundle: false,
      entryPoints: mainEntryPoints,
      format: "esm",
      logLevel: "info",
      outbase: ".",
      outdir: path.join("desktop", outdir),
      platform: "node",
      target: nodeTarget,
      tsconfig: path.join("desktop", "tsconfig.electron.json"),
    },
    {
      absWorkingDir: repoRootDir,
      bundle: true,
      external: ["electron"],
      entryPoints: [preloadEntryPoint],
      format: "cjs",
      logLevel: "info",
      outbase: ".",
      outdir: path.join("desktop", outdir),
      platform: "node",
      target: nodeTarget,
      tsconfig: path.join("desktop", "tsconfig.preload.json"),
    },
  ];
};

const startBuildContexts = async () => {
  const buildOptions = await createBuildOptions();
  const contexts = await Promise.all(
    buildOptions.map((options) => createEsbuildContext(options)),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  return contexts;
};

const disposeBuildContexts = async () => {
  const contextsToDispose = buildContexts;
  buildContexts = [];
  await Promise.all(contextsToDispose.map((ctx) => ctx.dispose()));
};

const rebuildGraph = async () => {
  if (shuttingDown) {
    return;
  }

  console.log("[electron-build] Refreshing watch graph");
  await disposeBuildContexts();
  buildContexts = await startBuildContexts();
};

const scheduleGraphRefresh = () => {
  if (shuttingDown) {
    return;
  }

  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }

  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildChain = rebuildChain
      .catch(() => undefined)
      .then(async () => {
        await rebuildGraph();
      });
  }, 150);
};

const startRootWatchers = () => {
  for (const root of graphWatchRoots) {
    const absoluteRoot = path.join(repoRootDir, root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    const watcher = watchFs(
      absoluteRoot,
      { recursive: true },
      (eventType, filename) => {
        if (
          eventType !== "rename" ||
          typeof filename !== "string" ||
          !filename.endsWith(".ts")
        ) {
          return;
        }
        scheduleGraphRefresh();
      },
    );
    rootWatchers.push(watcher);
  }
};

const cleanOutdir = async () => {
  await fsPromises.rm(path.join(projectDir, outdir), {
    force: true,
    recursive: true,
  });
};

const shutdown = async (exitCode) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }

  for (const watcher of rootWatchers) {
    watcher.close();
  }

  await rebuildChain.catch(() => undefined);
  await disposeBuildContexts();
  process.exit(exitCode);
};

await cleanOutdir();
buildContexts = await startBuildContexts();
startRootWatchers();

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(143);
});

await new Promise(() => {});
