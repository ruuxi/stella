import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRootDir = path.resolve(desktopDir, "..");
const cacheFilePath = path.join(desktopDir, ".low-resource-build-cache.json");

const inputRoots = [
  "desktop",
  "runtime",
  "package.json",
  "bun.lock",
  "tsconfig.json",
];

const ignoredPathSegments = new Set([
  "dist",
  "dist-electron",
  "release",
  "node_modules",
  ".vite",
  ".stella-dev-runtime",
]);

const requiredOutputs = [
  "desktop/dist/index.html",
  "desktop/dist/mini.html",
  "desktop/dist/overlay.html",
  "desktop/dist/pet.html",
  "desktop/dist-electron/desktop/electron/main.js",
  "desktop/dist-electron/desktop/electron/preload.js",
  "desktop/dist-electron/desktop/electron/store-web-preload.js",
  "desktop/dist-electron/runtime/worker/entry.js",
  "desktop/dist-electron/runtime/kernel/cli/stella-computer.js",
  "desktop/dist-electron/runtime/kernel/cli/stella-connect.js",
  "desktop/dist-electron/runtime/kernel/cli/stella-media.js",
  "desktop/dist-electron/runtime/kernel/tools/deferred-delete-cli.js",
];

const shouldIgnoreRelativePath = (relativePath) =>
  relativePath === path.join("desktop", ".low-resource-build-cache.json") ||
  relativePath
    .split(path.sep)
    .some((segment) => ignoredPathSegments.has(segment));

const collectFiles = () => {
  const files = [];

  const visit = (absolutePath) => {
    const relativePath = path.relative(repoRootDir, absolutePath);
    if (!relativePath || shouldIgnoreRelativePath(relativePath)) {
      return;
    }

    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) {
        visit(path.join(absolutePath, entry));
      }
      return;
    }

    if (stat.isFile()) {
      files.push(relativePath);
    }
  };

  for (const inputRoot of inputRoots) {
    const absolutePath = path.join(repoRootDir, inputRoot);
    if (existsSync(absolutePath)) {
      visit(absolutePath);
    }
  }

  files.sort();
  return files;
};

const fingerprintInputs = () => {
  const hash = createHash("sha256");
  for (const relativePath of collectFiles()) {
    const absolutePath = path.join(repoRootDir, relativePath);
    const stat = lstatSync(absolutePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(stat.size));
    hash.update("\0");
    hash.update(String(stat.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const readCache = () => {
  try {
    return JSON.parse(readFileSync(cacheFilePath, "utf8"));
  } catch {
    return null;
  }
};

const writeCache = (fingerprint) => {
  mkdirSync(path.dirname(cacheFilePath), { recursive: true });
  writeFileSync(
    cacheFilePath,
    JSON.stringify(
      {
        fingerprint,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
};

const requiredOutputsExist = () =>
  requiredOutputs.every((relativePath) =>
    existsSync(path.join(repoRootDir, relativePath)),
  );

const run = (command, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRootDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited via ${signal}`));
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });

const currentFingerprint = fingerprintInputs();
const cachedFingerprint = readCache()?.fingerprint;

if (cachedFingerprint === currentFingerprint && requiredOutputsExist()) {
  console.log("[electron-low-resource] Build outputs are current; skipping build.");
  process.exit(0);
}

console.log("[electron-low-resource] Build inputs changed; rebuilding.");
await run("bun", ["run", "build"]);
await run("node", ["desktop/scripts/dev-electron-build.mjs", "--once"]);
writeCache(fingerprintInputs());
