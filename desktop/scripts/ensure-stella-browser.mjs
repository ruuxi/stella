#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const allowBuildFallback = args.has("--allow-build-fallback");
const bestEffort = args.has("--best-effort");
if (process.env.STELLA_SKIP_BROWSER_HYDRATE === "1") {
  process.exit(0);
}
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const browserRoot = path.join(repoRoot, "desktop", "stella-browser");

const platformKey =
  os.platform() === "win32" && os.arch() === "x64"
    ? "win-x64"
    : os.platform() === "darwin" && os.arch() === "arm64"
      ? "darwin-arm64"
      : os.platform() === "darwin" && os.arch() === "x64"
        ? "darwin-x64"
        : os.platform() === "linux" && os.arch() === "arm64"
          ? "linux-arm64"
          : os.platform() === "linux" && os.arch() === "x64"
            ? "linux-x64"
            : "";

if (!platformKey) {
  process.stderr.write(
    `[stella-browser] Unsupported platform ${os.platform()}-${os.arch()}.\n`,
  );
  process.exit(bestEffort ? 0 : 1);
}

const hydratedName =
  platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
const hydratedPath = path.join(browserRoot, "out", platformKey, hydratedName);

const download = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "download-stella-browser.mjs")],
  { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
);
if (download.status === 0 && existsSync(hydratedPath)) {
  process.stdout.write(download.stdout);
  process.exit(0);
}

const downloadDetail = (
  download.stderr ||
  download.stdout ||
  "download failed"
).trim();
if (allowBuildFallback) {
  process.stderr.write(
    `[stella-browser] Published artifact unavailable; building the checked-out source (${downloadDetail}).\n`,
  );
  const cargo = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--manifest-path",
      path.join(browserRoot, "cli", "Cargo.toml"),
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: "inherit" },
  );
  const builtPath = path.join(
    browserRoot,
    "cli",
    "target",
    "release",
    platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser",
  );
  if (cargo.status === 0 && existsSync(builtPath)) {
    mkdirSync(path.dirname(hydratedPath), { recursive: true });
    copyFileSync(builtPath, hydratedPath);
    if (process.platform !== "win32") chmodSync(hydratedPath, 0o755);
    process.stdout.write(
      `[stella-browser] Built and hydrated ${hydratedPath} from source.\n`,
    );
    process.exit(0);
  }
}

process.stderr.write(
  `[stella-browser] Could not hydrate the browser service: ${downloadDetail}\n`,
);
process.exit(bestEffort ? 0 : 1);
