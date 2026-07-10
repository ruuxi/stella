#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MANIFEST_URL =
  process.env.STELLA_BROWSER_MANIFEST_URL ??
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/stella-browser/current.json";

const args = process.argv.slice(2);
let manifestUrl = DEFAULT_MANIFEST_URL;
let platformOverride = "";
let force = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--manifest-url" && args[index + 1]) {
    manifestUrl = args[++index];
  } else if (arg === "--platform" && args[index + 1]) {
    platformOverride = args[++index];
  } else if (arg === "--force") {
    force = true;
  } else {
    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }
}

const platformKey =
  platformOverride ||
  (os.platform() === "win32" && os.arch() === "x64"
    ? "win-x64"
    : os.platform() === "darwin" && os.arch() === "arm64"
      ? "darwin-arm64"
      : os.platform() === "darwin" && os.arch() === "x64"
        ? "darwin-x64"
        : os.platform() === "linux" && os.arch() === "arm64"
          ? "linux-arm64"
          : os.platform() === "linux" && os.arch() === "x64"
            ? "linux-x64"
            : "");
if (!platformKey) {
  throw new Error(
    `Unsupported Stella Browser platform: ${os.platform()}-${os.arch()}`,
  );
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.join(
  repoRoot,
  "desktop",
  "stella-browser",
  "out",
  platformKey,
);
const binaryName =
  platformKey === "win-x64" ? "stella-browser.exe" : "stella-browser";
const binaryPath = path.join(outDir, binaryName);
const installedManifestPath = path.join(outDir, ".stella-browser.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalizeSha = (value) =>
  String(value ?? "")
    .replace(/^sha256:/i, "")
    .toLowerCase();

const response = await fetch(manifestUrl);
if (!response.ok) {
  throw new Error(
    `Stella Browser manifest download failed (${response.status}).`,
  );
}
const manifest = await response.json();
const asset = manifest?.assets?.[platformKey];
if (
  !asset ||
  !/^https:\/\//i.test(String(asset.url ?? "")) ||
  !/^[0-9a-f]{64}$/.test(normalizeSha(asset.sha256)) ||
  !Number.isInteger(Number(asset.size)) ||
  Number(asset.size) <= 0
) {
  throw new Error(
    `Stella Browser manifest has no valid ${platformKey} artifact.`,
  );
}

if (!force && existsSync(binaryPath)) {
  try {
    const installed = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    if (
      normalizeSha(installed?.asset?.sha256) === normalizeSha(asset.sha256) &&
      sha256(readFileSync(binaryPath)) === normalizeSha(asset.sha256)
    ) {
      process.stdout.write(
        `Stella Browser ${platformKey} is already current.\n`,
      );
      process.exit(0);
    }
  } catch {
    // Missing/stale local metadata falls through to a verified refresh.
  }
}

const artifactResponse = await fetch(asset.url);
if (!artifactResponse.ok) {
  throw new Error(
    `Stella Browser artifact download failed (${artifactResponse.status}).`,
  );
}
const bytes = Buffer.from(await artifactResponse.arrayBuffer());
if (
  bytes.byteLength !== Number(asset.size) ||
  sha256(bytes) !== normalizeSha(asset.sha256)
) {
  throw new Error(
    "Stella Browser artifact did not match its published size/hash.",
  );
}

mkdirSync(outDir, { recursive: true });
const tempPath = `${binaryPath}.${process.pid}.tmp`;
try {
  writeFileSync(tempPath, bytes, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(tempPath, 0o755);
  if (process.platform === "win32") rmSync(binaryPath, { force: true });
  renameSync(tempPath, binaryPath);
  writeFileSync(
    installedManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceManifestUrl: manifestUrl,
        sourceSha: manifest.sourceSha ?? null,
        platform: platformKey,
        asset,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(tempPath, { force: true });
}

process.stdout.write(
  `Installed Stella Browser ${platformKey} into ${outDir}.\n`,
);
