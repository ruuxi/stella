#!/usr/bin/env node

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, "..");

const DEFAULT_MANIFEST_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "manifest.json");
const DEFAULT_LABELS_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "emoji-labels.json");
const DEFAULT_ASSETS_ROOT = path.join(FRONTEND_ROOT, "public", "emotes", "assets");
const DEFAULT_PROVIDER = "7tv";
const DEFAULT_MAX_FAMILIES_PER_EMOJI = 2;

const VARIATION_SELECTOR_16 = /\uFE0F/g;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    labelsPath: DEFAULT_LABELS_PATH,
    assetsRoot: DEFAULT_ASSETS_ROOT,
    provider: DEFAULT_PROVIDER,
    maxFamiliesPerEmoji: DEFAULT_MAX_FAMILIES_PER_EMOJI,
    dryRun: false,
    keepUnlabeled: true,
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--no-keep-unlabeled") {
      opts.keepUnlabeled = false;
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      opts.manifestPath = path.resolve(arg.slice("--manifest=".length));
      continue;
    }
    if (arg.startsWith("--labels=")) {
      opts.labelsPath = path.resolve(arg.slice("--labels=".length));
      continue;
    }
    if (arg.startsWith("--assets-root=")) {
      opts.assetsRoot = path.resolve(arg.slice("--assets-root=".length));
      continue;
    }
    if (arg.startsWith("--provider=")) {
      opts.provider = arg.slice("--provider=".length).trim();
      continue;
    }
    if (arg.startsWith("--max-families-per-emoji=")) {
      const parsed = Number.parseInt(arg.slice("--max-families-per-emoji=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.maxFamiliesPerEmoji = parsed;
      }
    }
  }

  return opts;
};

const loadJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const normalizeEmoji = (emoji) => String(emoji ?? "").replace(VARIATION_SELECTOR_16, "");

const familyKey = (code) => {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return "unknown";
  const cleaned = trimmed.replace(/[^A-Za-z0-9]/g, "");
  if (!cleaned) return trimmed.slice(0, 4).toLowerCase() || "unknown";

  const leadingAlphaMatch = cleaned.match(/^[A-Za-z]+/);
  const leadingAlpha = leadingAlphaMatch ? leadingAlphaMatch[0] : cleaned;

  const words = leadingAlpha.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g);
  if (words && words.length > 0) {
    return words[0].toLowerCase();
  }

  return leadingAlpha.slice(0, 5).toLowerCase() || "unknown";
};

const confidenceOf = (value) =>
  Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;

const scoreEntry = (entry) => confidenceOf(entry.confidence);

const toMapByCode = (items) => {
  const map = new Map();
  for (const item of items) {
    if (item && typeof item.code === "string") {
      map.set(item.code, item);
    }
  }
  return map;
};

const listFilesRecursive = async (dirPath) => {
  const files = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
};

const bytesToMb = (bytes) => Number((bytes / (1024 * 1024)).toFixed(2));

const main = async () => {
  const opts = parseArgs();
  const manifest = await loadJson(opts.manifestPath);
  const labelsPayload = await loadJson(opts.labelsPath);

  if (!Array.isArray(manifest?.emotes)) {
    throw new Error(`Invalid manifest at ${opts.manifestPath}`);
  }
  if (!Array.isArray(labelsPayload?.labels)) {
    throw new Error(`Invalid labels at ${opts.labelsPath}`);
  }

  const manifestEmotes = manifest.emotes;
  const labels = labelsPayload.labels;
  const manifestByCode = toMapByCode(manifestEmotes);
  const labelByCode = toMapByCode(labels);

  const targetLabels = labels.filter(
    (entry) => entry?.provider === opts.provider && typeof entry.code === "string",
  );
  const nonTargetLabels = labels.filter((entry) => entry?.provider !== opts.provider);

  const byEmoji = new Map();
  for (const entry of targetLabels) {
    const key = normalizeEmoji(entry.emoji);
    if (!key) continue;
    const arr = byEmoji.get(key);
    if (arr) {
      arr.push(entry);
    } else {
      byEmoji.set(key, [entry]);
    }
  }

  const keptTargetCodes = new Set();

  for (const [emoji, group] of byEmoji.entries()) {
    const byFamily = new Map();
    for (const entry of group) {
      const family = familyKey(entry.code);
      const existing = byFamily.get(family);
      if (
        !existing ||
        scoreEntry(entry) > scoreEntry(existing) ||
        (scoreEntry(entry) === scoreEntry(existing) && entry.code.localeCompare(existing.code) < 0)
      ) {
        byFamily.set(family, entry);
      }
    }

    const chosenFamilies = Array.from(byFamily.entries())
      .sort((a, b) => {
        const scoreDiff = scoreEntry(b[1]) - scoreEntry(a[1]);
        if (scoreDiff !== 0) return scoreDiff;
        return a[0].localeCompare(b[0]);
      })
      .slice(0, opts.maxFamiliesPerEmoji);

    for (const [, entry] of chosenFamilies) {
      keptTargetCodes.add(entry.code);
    }
  }

  const filteredLabels = [
    ...nonTargetLabels,
    ...targetLabels.filter((entry) => keptTargetCodes.has(entry.code)),
  ].sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const filteredEmotes = manifestEmotes.filter((entry) => {
    if (entry.provider !== opts.provider) {
      return true;
    }
    if (keptTargetCodes.has(entry.code)) {
      return true;
    }
    if (opts.keepUnlabeled && !labelByCode.has(entry.code)) {
      return true;
    }
    return false;
  });

  const preTargetCount = manifestEmotes.filter((entry) => entry.provider === opts.provider).length;
  const postTargetCount = filteredEmotes.filter((entry) => entry.provider === opts.provider).length;

  const keptUrls = new Set(
    filteredEmotes
      .map((entry) => entry.url)
      .filter((url) => typeof url === "string" && url.startsWith("/")),
  );

  const providerDir = path.join(opts.assetsRoot, opts.provider);
  let deletedFiles = 0;
  let deletedBytes = 0;
  let candidateDeletes = 0;

  try {
    const files = await listFilesRecursive(providerDir);
    for (const filePath of files) {
      const relativePath = path
        .relative(path.join(FRONTEND_ROOT, "public"), filePath)
        .split(path.sep)
        .join("/");
      const asUrl = `/${relativePath}`;
      if (!keptUrls.has(asUrl)) {
        candidateDeletes += 1;
        if (!opts.dryRun) {
          const info = await stat(filePath);
          await rm(filePath, { force: true });
          deletedFiles += 1;
          deletedBytes += info.size;
        }
      }
    }
  } catch {
    // provider directory may not exist
  }

  console.log(`[prune] Provider: ${opts.provider}`);
  console.log(`[prune] Max families per emoji: ${opts.maxFamiliesPerEmoji}`);
  console.log(`[prune] Target labels: ${targetLabels.length}`);
  console.log(`[prune] Emoji buckets: ${byEmoji.size}`);
  console.log(
    `[prune] Target emotes: ${preTargetCount} -> ${postTargetCount} (removed ${preTargetCount - postTargetCount})`,
  );
  console.log(`[prune] Total manifest emotes: ${manifestEmotes.length} -> ${filteredEmotes.length}`);
  console.log(`[prune] Labels: ${labels.length} -> ${filteredLabels.length}`);
  console.log(`[prune] Asset delete candidates (${opts.provider}): ${candidateDeletes}`);

  if (opts.dryRun) {
    console.log("[prune] Dry run only. No files or JSON were changed.");
    return;
  }

  const nextManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    emotes: filteredEmotes,
  };
  const nextLabels = {
    ...labelsPayload,
    generatedAt: new Date().toISOString(),
    labels: filteredLabels,
  };

  await writeFile(opts.manifestPath, JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
  await writeFile(opts.labelsPath, JSON.stringify(nextLabels, null, 2) + "\n", "utf8");

  console.log(
    `[prune] Deleted assets: ${deletedFiles} files (${bytesToMb(deletedBytes)} MB)`,
  );
  console.log("[prune] Wrote updated manifest and emoji-labels.");
};

main().catch((error) => {
  console.error(`[prune] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
