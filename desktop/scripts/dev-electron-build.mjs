import { context as createEsbuildContext } from "esbuild";
import {
  existsSync,
  promises as fsPromises,
  watch as watchFs,
} from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const outdir = "dist-electron";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const graphWatchRoots = [
  "electron",
  "src/shared/contracts",
  "src/shared/ai",
  "src/convex",
  "src/prompts",
];
const mainEntryRoots = [
  "electron",
  "src/shared/contracts",
  "src/shared/ai",
];
const mainExplicitEntries = [
  "src/convex/api.ts",
  "src/prompts/dashboard-page-focus.ts",
];
const preloadEntryPoint = "electron/preload.ts";

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
  const rootAbsolutePath = path.join(projectDir, rootRelativePath);
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

      results.push(normalizePath(path.relative(projectDir, absolutePath)));
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
    existsSync(path.join(projectDir, entryPath)),
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
      absWorkingDir: projectDir,
      bundle: false,
      entryPoints: mainEntryPoints,
      format: "esm",
      logLevel: "info",
      outbase: ".",
      outdir,
      platform: "node",
      target: nodeTarget,
      tsconfig: "tsconfig.electron.json",
    },
    {
      absWorkingDir: projectDir,
      bundle: false,
      entryPoints: [preloadEntryPoint],
      format: "cjs",
      logLevel: "info",
      outbase: ".",
      outdir,
      platform: "node",
      target: nodeTarget,
      tsconfig: "tsconfig.preload.json",
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
    const absoluteRoot = path.join(projectDir, root);
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

buildContexts = await startBuildContexts();
startRootWatchers();

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(143);
});

await new Promise(() => {});
