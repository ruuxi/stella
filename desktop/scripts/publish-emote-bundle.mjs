#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create as createTar } from "tar";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const DEFAULT_SOURCE_DIR = path.join(FRONTEND_ROOT, "public", "emotes");
const DEFAULT_OUTPUT_DIR = path.join(FRONTEND_ROOT, "release", "emotes");
const DEFAULT_PUBLIC_BASE_URL =
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev/emotes";
const BUNX_BIN = process.platform === "win32" ? "bunx.cmd" : "bunx";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    sourceDir: DEFAULT_SOURCE_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    publicBaseUrl:
      process.env.STELLA_EMOTE_PUBLIC_BASE_URL?.trim() ||
      DEFAULT_PUBLIC_BASE_URL,
    bucket: process.env.STELLA_EMOTE_R2_BUCKET?.trim() || "",
    version: process.env.STELLA_EMOTE_VERSION?.trim() || "",
    publish: false,
  };

  for (const arg of args) {
    if (arg === "--publish") {
      options.publish = true;
      continue;
    }
    if (arg.startsWith("--source=")) {
      options.sourceDir = path.resolve(arg.slice("--source=".length));
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.outputDir = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--public-base-url=")) {
      options.publicBaseUrl = arg.slice("--public-base-url=".length).trim();
      continue;
    }
    if (arg.startsWith("--bucket=")) {
      options.bucket = arg.slice("--bucket=".length).trim();
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length).trim();
    }
  }

  return options;
};

const ensureExists = async (targetPath, label) => {
  try {
    await stat(targetPath);
  } catch {
    throw new Error(`${label} not found: ${targetPath}`);
  }
};

const joinUrl = (base, suffix) =>
  `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;

const normalizeVersion = (value) => {
  const trimmed = value.trim();
  const normalized = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "emotes";
};

const defaultVersionFromManifest = async (sourceDir) => {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  const generatedAt =
    typeof parsed?.generatedAt === "string" && parsed.generatedAt.trim()
      ? parsed.generatedAt.trim()
      : new Date().toISOString();
  return normalizeVersion(
    generatedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "Z"),
  );
};

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`.trim(),
        ),
      );
    });
  });

const writeJson = async (filePath, payload) => {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const main = async () => {
  const options = parseArgs();
  if (options.publish && !options.bucket) {
    throw new Error(
      "Set STELLA_EMOTE_R2_BUCKET or pass --bucket=<bucket> when using --publish.",
    );
  }

  await ensureExists(options.sourceDir, "Emote source directory");
  await ensureExists(
    path.join(options.sourceDir, "manifest.json"),
    "Emote manifest",
  );
  await ensureExists(
    path.join(options.sourceDir, "emoji-index.json"),
    "Emoji index",
  );
  await ensureExists(
    path.join(options.sourceDir, "emoji-labels.json"),
    "Emoji labels",
  );
  await ensureExists(
    path.join(options.sourceDir, "assets"),
    "Emote assets directory",
  );

  const version =
    options.version || (await defaultVersionFromManifest(options.sourceDir));
  const releaseDir = path.join(options.outputDir, "releases", version);
  const stagingRoot = path.join(options.outputDir, ".staging", version);
  const stagedPublicDir = path.join(stagingRoot, "public");
  const stagedEmotesDir = path.join(stagedPublicDir, "emotes");
  const archivePath = path.join(releaseDir, "emotes.tar.zst");
  const checksumPath = path.join(releaseDir, "sha256.txt");
  const currentJsonPath = path.join(options.outputDir, "current.json");
  const archiveUrl = joinUrl(
    options.publicBaseUrl,
    `releases/${version}/emotes.tar.zst`,
  );
  const checksumUrl = joinUrl(
    options.publicBaseUrl,
    `releases/${version}/sha256.txt`,
  );

  await rm(stagingRoot, { recursive: true, force: true });
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(stagedPublicDir, { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await cp(options.sourceDir, stagedEmotesDir, { recursive: true });

  await createTar(
    {
      cwd: stagingRoot,
      file: archivePath,
      portable: true,
      zstd: true,
    },
    ["public/emotes"],
  );

  const archiveBytes = await readFile(archivePath);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  await writeFile(checksumPath, `${sha256}  emotes.tar.zst\n`, "utf8");

  const currentPayload = {
    version,
    archiveUrl,
    sha256,
    sha256Url: checksumUrl,
    publishedAt: new Date().toISOString(),
  };

  await writeJson(currentJsonPath, currentPayload);
  await rm(stagingRoot, { recursive: true, force: true });

  console.log(`[emote-bundle] Version: ${version}`);
  console.log(`[emote-bundle] Public base URL: ${options.publicBaseUrl}`);
  console.log(`[emote-bundle] Archive: ${archivePath}`);
  console.log(`[emote-bundle] Checksum: ${checksumPath}`);
  console.log(`[emote-bundle] Current manifest: ${currentJsonPath}`);

  if (!options.publish) {
    console.log(
      "[emote-bundle] Publish skipped. Re-run with --publish to upload to R2.",
    );
    return;
  }

  const uploads = [
    {
      key: `emotes/releases/${version}/emotes.tar.zst`,
      file: archivePath,
      contentType: "application/zstd",
      cacheControl: "public, max-age=31536000, immutable",
    },
    {
      key: `emotes/releases/${version}/sha256.txt`,
      file: checksumPath,
      contentType: "text/plain; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    },
    {
      key: "emotes/current.json",
      file: currentJsonPath,
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=60, stale-while-revalidate=300",
    },
  ];

  for (const upload of uploads) {
    console.log(`[emote-bundle] Uploading ${upload.key}`);
    await runCommand(BUNX_BIN, [
      "wrangler",
      "r2",
      "object",
      "put",
      `${options.bucket}/${upload.key}`,
      "--remote",
      "--content-type",
      upload.contentType,
      "--cache-control",
      upload.cacheControl,
      "--file",
      upload.file,
    ]);
  }

  console.log("[emote-bundle] Upload complete.");
  console.log(
    `[emote-bundle] Live manifest: ${joinUrl(options.publicBaseUrl, "current.json")}`,
  );
};

main().catch((error) => {
  console.error(
    `[emote-bundle] Failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
