#!/usr/bin/env node
// Downloads platform-relevant native helpers from R2 into
// desktop/native/out/<platform>/. New manifests publish per-file refs so updates
// only download changed files; older manifests still use the platform tarball
// fallback.
//
// Usage:
//   bun run native:download [--manifest-url <url>] [--platform <key>] [--force]
//
// Defaults to the canonical R2 manifest URL and the host platform. Pass --force
// to re-download even when binaries already look present.

import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MANIFEST_URL =
  process.env.STELLA_NATIVE_HELPERS_MANIFEST_URL ??
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers/current.json";
const DOWNLOAD_RETRY_DELAYS_MS = [750, 1_500, 3_000, 6_000];

const __dirname = import.meta.dirname;
const repoRoot = path.resolve(__dirname, "..", "..");

const args = process.argv.slice(2);
let manifestUrl = DEFAULT_MANIFEST_URL;
let platformOverride = "";
let force = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--manifest-url" && i + 1 < args.length) {
    manifestUrl = args[++i];
  } else if (arg === "--platform" && i + 1 < args.length) {
    platformOverride = args[++i];
  } else if (arg === "--force") {
    force = true;
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "Usage: bun run native:download [--manifest-url <url>] [--platform <key>] [--force]\n",
    );
    process.exit(0);
  } else {
    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }
}

const platformKey =
  platformOverride ||
  (process.platform === "win32" && process.arch === "x64"
    ? "win-x64"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : "");

if (!platformKey) {
  process.stderr.write(
    `Unsupported platform/arch combo: ${process.platform}/${process.arch}. Pass --platform to override.\n`,
  );
  process.exit(1);
}

const platformDir =
  platformKey === "win-x64"
    ? "win32"
    : platformKey.startsWith("darwin-")
      ? "darwin"
      : platformKey.startsWith("linux-")
        ? "linux"
        : null;
if (!platformDir) {
  process.stderr.write(
    `Cannot map platform key ${platformKey} to a native/out subdirectory.\n`,
  );
  process.exit(1);
}

const outDir = path.join(repoRoot, "desktop", "native", "out", platformDir);
const installManifestPath = path.join(outDir, ".stella-native-helpers.json");
const sentinel = path.join(
  outDir,
  platformDir === "win32" ? "window_info.exe" : "window_info",
);
if (!force && existsSync(sentinel)) {
  process.stdout.write(
    `Native helpers for ${platformKey} already look present at ${outDir} (pass --force to refresh).\n`,
  );
  process.exit(0);
}

const tarPath = (filePath) => {
  if (process.platform !== "win32") return filePath;
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!driveMatch) return normalized;
  return `/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
};

const nativeToolPath = () => {
  const separator = process.platform === "win32" ? ";" : ":";
  const paths = [
    process.env.PATH,
    process.platform === "darwin" ? "/opt/homebrew/bin" : "",
    process.platform === "darwin" ? "/usr/local/bin" : "",
    process.platform === "darwin" ? "/usr/bin" : "",
    process.platform === "darwin" ? "/bin" : "",
    process.platform === "darwin" ? "/usr/sbin" : "",
    process.platform === "darwin" ? "/sbin" : "",
    process.platform === "win32" ? "C:\\Program Files\\zstd" : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\zstd" : "",
    process.platform === "win32" ? "C:\\ProgramData\\chocolatey\\bin" : "",
    process.platform === "win32" ? "C:\\msys64\\usr\\bin" : "",
    process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin" : "",
    process.platform === "win32" ? "C:\\Windows\\System32" : "",
  ]
    .flatMap((entry) => (entry ? entry.split(separator) : []))
    .filter(Boolean);
  return [...new Set(paths)].join(separator);
};

const readInstalledManifest = () => {
  try {
    return JSON.parse(readFileSync(installManifestPath, "utf8"));
  } catch {
    return null;
  }
};

const existingHelpersMatch = (manifest, asset) => {
  if (!existsSync(sentinel)) return false;
  const installed = readInstalledManifest();
  if (!installed || installed.schemaVersion !== 1) return false;
  if (installed.platform && installed.platform !== platformKey) return false;

  const expectedAssetSha = String(asset.sha256 ?? "").toLowerCase();
  const installedAssetSha = String(installed.asset?.sha256 ?? "").toLowerCase();
  const installedManifestAssetSha = String(
    installed.assets?.[platformKey]?.sha256 ?? "",
  ).toLowerCase();
  if (
    expectedAssetSha &&
    (installedAssetSha === expectedAssetSha ||
      installedManifestAssetSha === expectedAssetSha)
  ) {
    return true;
  }

  return Boolean(
    manifest.sha &&
      installed.sha &&
      String(installed.sha).toLowerCase() === String(manifest.sha).toLowerCase(),
  );
};

const normalizeSha256 = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();

const normalizeManifestPath = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return normalized;
};

const manifestFilesForAsset = (asset) => {
  if (!Array.isArray(asset.files)) return [];
  const files = [];
  const seen = new Set();
  for (const item of asset.files) {
    if (!item || typeof item !== "object") continue;
    const relativePath = normalizeManifestPath(item.path);
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const sha256 = normalizeSha256(item.sha256);
    const size = Number(item.size);
    if (
      !relativePath ||
      !/^https:\/\//i.test(url) ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      !Number.isInteger(size) ||
      size < 0 ||
      seen.has(relativePath)
    ) {
      return [];
    }
    seen.add(relativePath);
    files.push({ path: relativePath, url, sha256, size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
};

const hashFileOrNull = (filePath) => {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
};

const existingRelativeFiles = (dir) => {
  const files = [];
  if (!existsSync(dir)) return files;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return files;
};

const chmodNativeHelperFiles = (dir) => {
  if (process.platform === "win32" || !existsSync(dir)) return;
  const setExec = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        setExec(full);
      } else if (entry.isFile()) {
        try {
          chmodSync(full, statSync(full).mode | 0o111);
        } catch {}
      }
    }
  };
  setExec(dir);
};

const installedManifestPayload = (manifest, asset, installMode, files) => ({
  schemaVersion: 1,
  sourceManifestUrl: manifestUrl,
  platform: platformKey,
  helperPlatformDir: platformDir,
  sha: manifest.sha ?? null,
  commit: manifest.commit ?? null,
  builtAt: manifest.builtAt ?? null,
  installedAt: new Date().toISOString(),
  installMode,
  asset: {
    url: asset.url,
    sha256: asset.sha256,
    size: asset.size ?? null,
  },
  ...(files.length
    ? {
        files: files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        })),
      }
    : {}),
});

const writeInstalledManifest = (manifest, asset, installMode, files = []) => {
  writeFileSync(
    installManifestPath,
    `${JSON.stringify(
      installedManifestPayload(manifest, asset, installMode, files),
      null,
      2,
    )}\n`,
  );
};

class RetryableDownloadError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RetryableDownloadError";
    this.status = status;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableHttpStatus = (status) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const errorMessageWithCause = (error) => {
  if (error instanceof Error) {
    const cause =
      typeof error.cause === "string"
        ? error.cause
        : error.cause instanceof Error
          ? error.cause.message
          : "";
    return `${error.message} ${cause}`.trim();
  }
  return String(error);
};

const isRetryableDownloadError = (error) => {
  if (error instanceof RetryableDownloadError) return true;
  return /fetch failed|network|timeout|timed out|econnreset|etimedout|eai_again|enotfound|socket|terminated|aborted/i.test(
    errorMessageWithCause(error),
  );
};

const withDownloadRetries = async (label, url, operation) => {
  let lastError;
  for (
    let attemptIndex = 0;
    attemptIndex <= DOWNLOAD_RETRY_DELAYS_MS.length;
    attemptIndex += 1
  ) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const nextDelayMs = DOWNLOAD_RETRY_DELAYS_MS[attemptIndex];
      if (nextDelayMs === undefined || !isRetryableDownloadError(error)) {
        throw error;
      }
      process.stderr.write(
        `${label} failed (${errorMessageWithCause(error)}); retrying in ${(nextDelayMs / 1000).toFixed(1)}s...\n`,
      );
      await wait(nextDelayMs);
    }
  }
  throw lastError;
};

process.stdout.write(`Resolving native helpers manifest: ${manifestUrl}\n`);
let manifestResp;
try {
  manifestResp = await withDownloadRetries(
    "Native helpers manifest request",
    manifestUrl,
    async () => {
      const response = await fetch(manifestUrl, {
        headers: { "User-Agent": "stella-native-download" },
      });
      if (!response.ok && isRetryableHttpStatus(response.status)) {
        throw new RetryableDownloadError(
          `HTTP ${response.status}`,
          response.status,
        );
      }
      return response;
    },
  );
} catch (error) {
  process.stderr.write(
    `Manifest request failed: ${errorMessageWithCause(error)}\n`,
  );
  process.exit(1);
}
if (!manifestResp.ok) {
  process.stderr.write(
    `Manifest request failed: HTTP ${manifestResp.status}\n`,
  );
  process.exit(1);
}
const manifest = await manifestResp.json();
if (manifest.schemaVersion !== 1) {
  process.stderr.write(
    `Unsupported native helpers manifest schema: ${manifest.schemaVersion}\n`,
  );
  process.exit(1);
}
const asset = manifest.assets?.[platformKey];
if (!asset) {
  process.stderr.write(`Manifest has no asset for ${platformKey}.\n`);
  process.exit(1);
}

if (existingHelpersMatch(manifest, asset)) {
  process.stdout.write(
    `Native helpers for ${platformKey} already match the current manifest at ${outDir}.\n`,
  );
  process.exit(0);
}

const tmpArchive = path.join(
  repoRoot,
  ".stella-native-helpers-download.tar.zst",
);
const tmpExtractDir = path.join(
  repoRoot,
  `.stella-native-helpers-extract-${platformKey}-${process.pid}`,
);
const tmpFilesDir = path.join(
  repoRoot,
  `.stella-native-helpers-files-${platformKey}-${process.pid}`,
);
const cleanupTempArtifacts = () => {
  rmSync(tmpArchive, { force: true });
  rmSync(tmpExtractDir, { recursive: true, force: true });
  rmSync(tmpFilesDir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupTempArtifacts();
    process.kill(process.pid, signal);
  });
}

const downloadVerifiedFile = async (file, destinationPath) => {
  await withDownloadRetries(
    `Native helper file ${file.path}`,
    file.url,
    async () => {
      rmSync(destinationPath, { force: true });
      await mkdir(path.dirname(destinationPath), { recursive: true });
      const response = await fetch(file.url, {
        headers: { "User-Agent": "stella-native-download" },
      });
      if (!response.ok || !response.body) {
        if (isRetryableHttpStatus(response.status)) {
          throw new RetryableDownloadError(
            `HTTP ${response.status}`,
            response.status,
          );
        }
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      const hash = createHash("sha256");
      const writeStream = createWriteStream(destinationPath);
      const reader = response.body.getReader();
      let downloaded = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          downloaded += value.byteLength;
          hash.update(value);
          if (!writeStream.write(value)) {
            await new Promise((resolve) => writeStream.once("drain", resolve));
          }
        }
        await new Promise((resolve, reject) => {
          writeStream.end((err) => (err ? reject(err) : resolve(undefined)));
        });
      } catch (error) {
        writeStream.destroy();
        rmSync(destinationPath, { force: true });
        throw error;
      }

      const actualSha = hash.digest("hex");
      if (downloaded !== file.size) {
        rmSync(destinationPath, { force: true });
        throw new Error(
          `Size mismatch for ${file.path}: expected ${file.size}, got ${downloaded}`,
        );
      }
      if (actualSha !== file.sha256) {
        rmSync(destinationPath, { force: true });
        throw new Error(
          `Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${actualSha}`,
        );
      }
    },
  );
};

const installFromArchive = async () => {
  if (typeof asset.url !== "string" || !/^https:\/\//i.test(asset.url)) {
    throw new Error("Native helper tarball URL is missing from the manifest.");
  }
  const expectedArchiveSha = normalizeSha256(asset.sha256);
  if (!/^[0-9a-f]{64}$/.test(expectedArchiveSha)) {
    throw new Error("Native helper tarball hash is invalid.");
  }

  await withDownloadRetries(
    `Native helpers download for ${platformKey}`,
    asset.url,
    async () => {
      cleanupTempArtifacts();
      process.stdout.write(
        `Downloading native helpers for ${platformKey} from ${asset.url}\n`,
      );
      const archiveResp = await fetch(asset.url, {
        headers: { "User-Agent": "stella-native-download" },
      });
      if (!archiveResp.ok || !archiveResp.body) {
        if (isRetryableHttpStatus(archiveResp.status)) {
          throw new RetryableDownloadError(
            `HTTP ${archiveResp.status}`,
            archiveResp.status,
          );
        }
        throw new Error(`Download failed: HTTP ${archiveResp.status}`);
      }

      const hash = createHash("sha256");
      const writeStream = createWriteStream(tmpArchive);
      const reader = archiveResp.body.getReader();
      let downloaded = 0;
      const totalBytes =
        Number(archiveResp.headers.get("content-length") ?? asset.size ?? 0) ||
        0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          downloaded += value.byteLength;
          hash.update(value);
          if (!writeStream.write(value)) {
            await new Promise((resolve) => writeStream.once("drain", resolve));
          }
          if (totalBytes > 0 && downloaded % (1024 * 1024) < value.byteLength) {
            process.stdout.write(
              `  ${(downloaded / 1024 / 1024).toFixed(1)} MiB / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB\r`,
            );
          }
        }
        await new Promise((resolve, reject) => {
          writeStream.end((err) => (err ? reject(err) : resolve(undefined)));
        });
      } catch (error) {
        writeStream.destroy();
        cleanupTempArtifacts();
        throw error;
      }
      process.stdout.write("\n");

      const actualSha = hash.digest("hex");
      if (actualSha.toLowerCase() !== expectedArchiveSha) {
        cleanupTempArtifacts();
        throw new Error(
          `Checksum mismatch for ${platformKey}: expected ${expectedArchiveSha}, got ${actualSha}`,
        );
      }
    },
  );

  await mkdir(tmpExtractDir, { recursive: true });

  process.stdout.write(`Extracting into ${tmpExtractDir}\n`);
  const tarArgs = [
    ...(process.platform === "win32" ? ["--force-local"] : []),
    "--zstd",
    "-xf",
    tarPath(tmpArchive),
    "-C",
    tarPath(tmpExtractDir),
  ];
  const tarResult = spawnSync("tar", tarArgs, {
    env: {
      ...process.env,
      PATH: nativeToolPath(),
    },
    stdio: "inherit",
  });
  if (tarResult.status !== 0) {
    cleanupTempArtifacts();
    if (existsSync(sentinel)) {
      process.stderr.write(
        `tar extraction failed; keeping existing native helpers at ${outDir}.\n`,
      );
      process.exit(0);
    }
    throw new Error(`tar extraction failed (${tarResult.status ?? 1}).`);
  }
  rmSync(tmpArchive, { force: true });

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const entry of readdirSync(tmpExtractDir)) {
    renameSync(path.join(tmpExtractDir, entry), path.join(outDir, entry));
  }
  await rm(tmpExtractDir, { recursive: true, force: true });
  chmodNativeHelperFiles(outDir);
  writeInstalledManifest(manifest, asset, "archive", assetFiles);
};

const installFromFiles = async (files) => {
  const changedFiles = files.filter(
    (file) => hashFileOrNull(path.join(outDir, file.path)) !== file.sha256,
  );
  const manifestPathSet = new Set(files.map((file) => file.path));
  const staleFiles = existingRelativeFiles(outDir).filter(
    (file) =>
      file !== ".stella-native-helpers.json" && !manifestPathSet.has(file),
  );
  if (changedFiles.length === 0 && staleFiles.length === 0) {
    process.stdout.write(
      `Native helpers for ${platformKey} already match file manifest at ${outDir}.\n`,
    );
    writeInstalledManifest(manifest, asset, "files", files);
    return;
  }

  await rm(tmpFilesDir, { recursive: true, force: true });
  await mkdir(tmpFilesDir, { recursive: true });
  process.stdout.write(
    `Downloading ${changedFiles.length} changed native helper file${changedFiles.length === 1 ? "" : "s"} for ${platformKey}.\n`,
  );
  for (const file of changedFiles) {
    await downloadVerifiedFile(file, path.join(tmpFilesDir, file.path));
  }

  await mkdir(outDir, { recursive: true });
  for (const staleFile of staleFiles) {
    rmSync(path.join(outDir, staleFile), { force: true });
  }
  for (const file of changedFiles) {
    const source = path.join(tmpFilesDir, file.path);
    const destination = path.join(outDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  chmodNativeHelperFiles(outDir);
  await rm(tmpFilesDir, { recursive: true, force: true });
  writeInstalledManifest(manifest, asset, "files", files);
};

const assetFiles = manifestFilesForAsset(asset);
try {
  if (assetFiles.length > 0) {
    await installFromFiles(assetFiles);
  } else {
    process.stdout.write(
      `Native helpers manifest has no file refs for ${platformKey}; using tarball fallback.\n`,
    );
    await installFromArchive();
  }
} catch (error) {
  cleanupTempArtifacts();
  if (assetFiles.length > 0) {
    process.stderr.write(
      `Incremental native helper update failed (${errorMessageWithCause(error)}); using tarball fallback.\n`,
    );
    try {
      await installFromArchive();
    } catch (fallbackError) {
      cleanupTempArtifacts();
      process.stderr.write(
        `Download failed: ${errorMessageWithCause(fallbackError)}\n`,
      );
      process.exit(1);
    }
  } else {
    process.stderr.write(`Download failed: ${errorMessageWithCause(error)}\n`);
    process.exit(1);
  }
}

process.stdout.write(
  `Native helpers for ${platformKey} installed (sha=${manifest.sha ?? "unknown"}).\n`,
);
