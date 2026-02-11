#!/usr/bin/env node

import { readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, "..");

const DEFAULT_MANIFEST_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "manifest.json");
const DEFAULT_PUBLIC_ROOT = path.join(FRONTEND_ROOT, "public");
const DEFAULT_MAX_EDGE = 128;
const DEFAULT_FPS = 12;
const DEFAULT_QUALITY = 60;
const DEFAULT_STATIC_QUALITY = 70;
const DEFAULT_COMPRESSION_LEVEL = 6;
const DEFAULT_MAX_BYTES = 320_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MIN_BYTES = 0;
const DEFAULT_ENCODER = "auto";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    publicRoot: DEFAULT_PUBLIC_ROOT,
    providers: [],
    maxEdge: DEFAULT_MAX_EDGE,
    fps: DEFAULT_FPS,
    quality: DEFAULT_QUALITY,
    staticQuality: DEFAULT_STATIC_QUALITY,
    compressionLevel: DEFAULT_COMPRESSION_LEVEL,
    maxBytes: DEFAULT_MAX_BYTES,
    minBytes: DEFAULT_MIN_BYTES,
    concurrency: DEFAULT_CONCURRENCY,
    limit: null,
    dryRun: false,
    forceReplace: false,
    encoder: DEFAULT_ENCODER,
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--force-replace") {
      opts.forceReplace = true;
      continue;
    }
    if (arg.startsWith("--encoder=")) {
      const value = arg.slice("--encoder=".length).trim().toLowerCase();
      if (value === "auto" || value === "ffmpeg" || value === "magick") {
        opts.encoder = value;
      }
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      opts.manifestPath = path.resolve(arg.slice("--manifest=".length));
      continue;
    }
    if (arg.startsWith("--public-root=")) {
      opts.publicRoot = path.resolve(arg.slice("--public-root=".length));
      continue;
    }
    if (arg.startsWith("--providers=")) {
      opts.providers = arg
        .slice("--providers=".length)
        .split(/[,\s]+/)
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (arg.startsWith("--max-edge=")) {
      const parsed = Number.parseInt(arg.slice("--max-edge=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.maxEdge = parsed;
      }
      continue;
    }
    if (arg.startsWith("--fps=")) {
      const parsed = Number.parseInt(arg.slice("--fps=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.fps = parsed;
      }
      continue;
    }
    if (arg.startsWith("--quality=")) {
      const parsed = Number.parseInt(arg.slice("--quality=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 100) {
        opts.quality = parsed;
      }
      continue;
    }
    if (arg.startsWith("--static-quality=")) {
      const parsed = Number.parseInt(arg.slice("--static-quality=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 100) {
        opts.staticQuality = parsed;
      }
      continue;
    }
    if (arg.startsWith("--compression-level=")) {
      const parsed = Number.parseInt(arg.slice("--compression-level=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 6) {
        opts.compressionLevel = parsed;
      }
      continue;
    }
    if (arg.startsWith("--max-bytes=")) {
      const parsed = Number.parseInt(arg.slice("--max-bytes=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.maxBytes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--min-bytes=")) {
      const parsed = Number.parseInt(arg.slice("--min-bytes=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        opts.minBytes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      const parsed = Number.parseInt(arg.slice("--concurrency=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.concurrency = parsed;
      }
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.limit = parsed;
      }
    }
  }

  return opts;
};

const loadJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const bytesToMb = (bytes) => Number((bytes / (1024 * 1024)).toFixed(2));

const runCommand = async (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk ?? "");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });

const runFfmpeg = async (args) => runCommand("ffmpeg", args);
const runMagick = async (args) => runCommand("magick", args);

const isAnimatedWebp = (buffer) =>
  buffer.includes(Buffer.from("ANMF")) || buffer.includes(Buffer.from("ANIM"));

const asLocalPath = (url, publicRoot) => {
  if (typeof url !== "string" || !url.startsWith("/")) {
    return null;
  }
  const relative = url.slice(1).split("/").join(path.sep);
  return path.join(publicRoot, relative);
};

const buildScaleFilter = (maxEdge) =>
  `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease:flags=lanczos`;

const transcodeWebp = async ({
  inputPath,
  outputPath,
  animated,
  maxEdge,
  fps,
  quality,
  compressionLevel,
}) => {
  const vf = animated
    ? `fps=${fps},${buildScaleFilter(maxEdge)}`
    : buildScaleFilter(maxEdge);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-an",
    "-c:v",
    "libwebp",
    "-lossless",
    "0",
    "-q:v",
    String(quality),
    "-compression_level",
    String(compressionLevel),
    "-pix_fmt",
    "yuva420p",
  ];

  if (animated) {
    args.push("-loop", "0");
  } else {
    args.push("-frames:v", "1");
  }

  args.push(outputPath);

  await runFfmpeg(args);
};

const transcodeWebpWithMagick = async ({
  inputPath,
  outputPath,
  animated,
  maxEdge,
  fps,
  quality,
}) => {
  const delay = Math.max(1, Math.round(100 / Math.max(1, fps)));
  const args = [
    inputPath,
    ...(animated ? ["-coalesce"] : []),
    "-resize",
    `${maxEdge}x${maxEdge}>`,
    ...(animated ? ["-set", "delay", String(delay), "-define", "webp:loop=0"] : []),
    "-define",
    "webp:lossless=false",
    "-define",
    "webp:method=6",
    "-define",
    "webp:alpha-quality=80",
    "-quality",
    String(quality),
    outputPath,
  ];
  await runMagick(args);
};

const transcodeWithFallback = async ({
  inputPath,
  outputPath,
  animated,
  maxEdge,
  fps,
  quality,
  compressionLevel,
  encoder,
}) => {
  if (encoder === "magick") {
    await transcodeWebpWithMagick({
      inputPath,
      outputPath,
      animated,
      maxEdge,
      fps,
      quality,
    });
    return { tool: "magick" };
  }

  if (encoder === "ffmpeg") {
    await transcodeWebp({
      inputPath,
      outputPath,
      animated,
      maxEdge,
      fps,
      quality,
      compressionLevel,
    });
    return { tool: "ffmpeg" };
  }

  try {
    await transcodeWebp({
      inputPath,
      outputPath,
      animated,
      maxEdge,
      fps,
      quality,
      compressionLevel,
    });
    return { tool: "ffmpeg" };
  } catch (ffmpegError) {
    try {
      await transcodeWebpWithMagick({
        inputPath,
        outputPath,
        animated,
        maxEdge,
        fps,
        quality,
      });
      return { tool: "magick" };
    } catch (magickError) {
      const ffmpegMessage =
        ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError);
      const magickMessage =
        magickError instanceof Error ? magickError.message : String(magickError);
      throw new Error(
        `ffmpeg failed: ${ffmpegMessage}\nmagick failed: ${magickMessage}`,
      );
    }
  }
};

const withConcurrency = async (items, limit, worker) => {
  const queue = [...items];
  const workers = [];
  const count = Math.max(1, Math.min(limit, items.length || 1));

  const run = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      await worker(item);
    }
  };

  for (let i = 0; i < count; i += 1) {
    workers.push(run());
  }
  await Promise.all(workers);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dedupeKeyForPath = (filePath) =>
  process.platform === "win32" ? filePath.toLowerCase() : filePath;

const isRetryableFsError = (error) => {
  const code = error?.code;
  return code === "EBUSY" || code === "EPERM";
};

const replaceFile = async (sourcePath, targetPath) => {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(targetPath, { force: true });
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRetryableFsError(error)) {
        throw error;
      }
      await sleep(80 * attempt);
    }
  }
};

const main = async () => {
  const opts = parseArgs();
  const manifest = await loadJson(opts.manifestPath);

  if (!Array.isArray(manifest?.emotes)) {
    throw new Error(`Invalid manifest at ${opts.manifestPath}`);
  }

  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-version"]);

  const providerFilter = new Set(opts.providers);
  const targetEmotes = manifest.emotes.filter((entry) => {
    if (providerFilter.size === 0) return true;
    return providerFilter.has(String(entry?.provider ?? "").toLowerCase());
  });

  const seenPaths = new Set();
  const targets = [];
  for (const entry of targetEmotes) {
    const filePath = asLocalPath(entry?.url, opts.publicRoot);
    if (!filePath) continue;
    const dedupeKey = dedupeKeyForPath(filePath);
    if (seenPaths.has(dedupeKey)) continue;
    seenPaths.add(dedupeKey);
    targets.push({
      filePath,
      code: String(entry?.code ?? ""),
      provider: String(entry?.provider ?? "unknown"),
    });
  }

  if (opts.limit && opts.limit > 0) {
    targets.splice(opts.limit);
  }

  const summary = {
    totalTargets: targets.length,
    optimized: 0,
    skippedMissing: 0,
    skippedSmall: 0,
    skippedUnsupported: 0,
    skippedNoGain: 0,
    failed: 0,
    beforeBytes: 0,
    afterBytes: 0,
    ffmpegEncodes: 0,
    magickEncodes: 0,
    errors: [],
  };

  console.log(`[optimize] Targets: ${targets.length}`);
  console.log(
    `[optimize] Settings: maxEdge=${opts.maxEdge}, fps=${opts.fps}, quality=${opts.quality}, staticQuality=${opts.staticQuality}, maxBytes=${opts.maxBytes}, concurrency=${opts.concurrency}, encoder=${opts.encoder}`,
  );
  if (providerFilter.size > 0) {
    console.log(`[optimize] Providers: ${Array.from(providerFilter).join(", ")}`);
  }
  if (opts.dryRun) {
    console.log("[optimize] Dry run enabled (files are not replaced).");
  }

  await withConcurrency(targets, opts.concurrency, async (target) => {
    let currentStat;
    try {
      currentStat = await stat(target.filePath);
    } catch {
      summary.skippedMissing += 1;
      return;
    }

    summary.beforeBytes += currentStat.size;

    if (currentStat.size < opts.minBytes) {
      summary.afterBytes += currentStat.size;
      summary.skippedSmall += 1;
      return;
    }

    if (path.extname(target.filePath).toLowerCase() !== ".webp") {
      summary.afterBytes += currentStat.size;
      summary.skippedUnsupported += 1;
      return;
    }
    const inputBuffer = await readFile(target.filePath);

    const animated = isAnimatedWebp(inputBuffer);
    const tempToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pass1Path = `${target.filePath}.opt-pass1-${tempToken}.webp`;
    const pass2Path = `${target.filePath}.opt-pass2-${tempToken}.webp`;
    let finalPath = pass1Path;

    try {
      const firstPass = await transcodeWithFallback({
        inputPath: target.filePath,
        outputPath: pass1Path,
        animated,
        maxEdge: opts.maxEdge,
        fps: opts.fps,
        quality: animated ? opts.quality : opts.staticQuality,
        compressionLevel: opts.compressionLevel,
        encoder: opts.encoder,
      });
      if (firstPass.tool === "ffmpeg") {
        summary.ffmpegEncodes += 1;
      } else {
        summary.magickEncodes += 1;
      }

      let finalStat = await stat(pass1Path);

      if (opts.maxBytes > 0 && finalStat.size > opts.maxBytes) {
        const secondPass = await transcodeWithFallback({
          inputPath: target.filePath,
          outputPath: pass2Path,
          animated,
          maxEdge: opts.maxEdge,
          fps: animated ? Math.max(8, opts.fps - 4) : opts.fps,
          quality: animated
            ? Math.max(20, opts.quality - 15)
            : Math.max(20, opts.staticQuality - 20),
          compressionLevel: opts.compressionLevel,
          encoder: opts.encoder,
        });
        if (secondPass.tool === "ffmpeg") {
          summary.ffmpegEncodes += 1;
        } else {
          summary.magickEncodes += 1;
        }
        const fallbackStat = await stat(pass2Path);
        if (fallbackStat.size < finalStat.size) {
          finalPath = pass2Path;
          finalStat = fallbackStat;
        }
      }

      if (!opts.forceReplace && finalStat.size >= currentStat.size) {
        summary.afterBytes += currentStat.size;
        summary.skippedNoGain += 1;
        return;
      }

      summary.afterBytes += finalStat.size;
      summary.optimized += 1;

      if (!opts.dryRun) {
        await replaceFile(finalPath, target.filePath);
      }
    } catch (error) {
      summary.afterBytes += currentStat.size;
      summary.failed += 1;
      if (summary.errors.length < 10) {
        summary.errors.push(
          `${target.provider}:${target.code} -> ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      await rm(pass1Path, { force: true }).catch(() => {});
      await rm(pass2Path, { force: true }).catch(() => {});
    }
  });

  const savedBytes = summary.beforeBytes - summary.afterBytes;

  console.log(`[optimize] Optimized: ${summary.optimized}`);
  console.log(`[optimize] Skipped missing: ${summary.skippedMissing}`);
  console.log(`[optimize] Skipped below min-bytes: ${summary.skippedSmall}`);
  console.log(`[optimize] Skipped unsupported: ${summary.skippedUnsupported}`);
  console.log(`[optimize] Skipped no gain: ${summary.skippedNoGain}`);
  console.log(`[optimize] Failed: ${summary.failed}`);
  console.log(`[optimize] Encodes via ffmpeg: ${summary.ffmpegEncodes}`);
  console.log(`[optimize] Encodes via magick: ${summary.magickEncodes}`);
  console.log(
    `[optimize] Bytes: ${summary.beforeBytes} -> ${summary.afterBytes} (saved ${savedBytes}, ${bytesToMb(
      savedBytes,
    )} MB)`,
  );

  if (summary.errors.length > 0) {
    console.warn("[optimize] Sample errors:");
    for (const line of summary.errors) {
      console.warn(`  - ${line}`);
    }
  }
};

main().catch((error) => {
  console.error(`[optimize] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
