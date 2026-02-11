#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_EMOTES_DIR = path.join(PROJECT_ROOT, "public", "emotes");
const ASSETS_DIR = path.join(PUBLIC_EMOTES_DIR, "assets");
const MANIFEST_PATH = path.join(PUBLIC_EMOTES_DIR, "manifest.json");

const DEFAULT_API_BASE = "https://emotes.adamcy.pl/v1";
const DEFAULT_SERVICES = "7tv.bttv.ffz";
const DEFAULT_CHANNELS = [
  "xqc",
  "forsen",
  "sodapoppin",
  "lirik",
  "nymn",
  "pokelawls",
];
const DEFAULT_MAX = 3000;
const PREFERRED_SIZES = ["4x", "3x", "2x", "1x"];
const PROVIDER_NAMES = {
  0: "twitch",
  1: "7tv",
  2: "bttv",
  3: "ffz",
};
const ALWAYS_INCLUDE_CODES = new Set([
  "FeelsBadMan",
  "Sadge",
  "PepeHands",
  "Deadge",
  "KEKW",
  "Pog",
  "PogChamp",
  "POGGERS",
  "HYPERS",
  "Fire",
  "OMEGALUL",
  "AYAYA",
  "peepoLove",
  "LOVE",
  "FeelsStrongMan",
  "PepoG",
  "nymnLove",
  "4Love",
  "Lovee",
  "iLOVEyou",
  "GIGACHAD",
  "Hmmge",
  "peepoThink",
]);

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {
    apiBase: process.env.TWITCH_EMOTE_API_URL ?? DEFAULT_API_BASE,
    services: process.env.TWITCH_EMOTE_SERVICES ?? DEFAULT_SERVICES,
    channels: [],
    download: true,
    clean: false,
    max: DEFAULT_MAX,
    concurrency: 10,
  };

  for (const arg of args) {
    if (arg === "--no-download") {
      opts.download = false;
      continue;
    }
    if (arg === "--clean") {
      opts.clean = true;
      continue;
    }
    if (arg.startsWith("--api=")) {
      opts.apiBase = arg.slice("--api=".length).trim();
      continue;
    }
    if (arg.startsWith("--services=")) {
      opts.services = arg.slice("--services=".length).trim();
      continue;
    }
    if (arg.startsWith("--channels=")) {
      opts.channels = arg
        .slice("--channels=".length)
        .split(/[,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean);
      continue;
    }
    if (arg.startsWith("--max=")) {
      const parsed = Number.parseInt(arg.slice("--max=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.max = parsed;
      }
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      const parsed = Number.parseInt(arg.slice("--concurrency=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.concurrency = parsed;
      }
    }
  }

  if (opts.channels.length === 0) {
    const envChannels = (process.env.TWITCH_EMOTE_CHANNELS ?? "")
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    opts.channels = envChannels.length > 0 ? envChannels : DEFAULT_CHANNELS;
  }

  return opts;
};

const fetchJson = async (url) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
};

const chooseUrl = (urls = []) => {
  const bySize = new Map();
  for (const entry of urls) {
    if (
      entry &&
      typeof entry.size === "string" &&
      typeof entry.url === "string" &&
      entry.url.trim().length > 0
    ) {
      bySize.set(entry.size, entry.url.trim());
    }
  }

  for (const preferred of PREFERRED_SIZES) {
    const hit = bySize.get(preferred);
    if (hit) return hit;
  }

  return bySize.values().next().value ?? "";
};

const normalizeCode = (code) => code.trim();
const isValidCode = (code) => code.length >= 2 && !/\s/.test(code);

const mapTemotesEmotes = (emotes, priority, source) => {
  const mapped = [];
  for (const emote of emotes ?? []) {
    const code = typeof emote.code === "string" ? normalizeCode(emote.code) : "";
    if (!isValidCode(code)) continue;

    const url = chooseUrl(emote.urls);
    if (!url) continue;

    const provider =
      PROVIDER_NAMES[
        Number.isFinite(Number(emote.provider)) ? Number(emote.provider) : 1
      ] ?? "7tv";
    mapped.push({
      code,
      url,
      provider,
      animated: /\.gif($|\?)/i.test(url),
      priority,
      source,
    });
  }
  return mapped;
};

const upsert = (target, candidate) => {
  const existing = target.get(candidate.code);
  if (!existing || candidate.priority >= existing.priority) {
    target.set(candidate.code, candidate);
  }
};

const toAbsoluteUrl = (value) => {
  if (value.startsWith("https://") || value.startsWith("http://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  return `https://${value}`;
};

const safeFilePart = (value) => {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 64) : "emote";
};

const fileExists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const detectExtension = (url) => {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext && ext.length <= 8) {
      return ext;
    }
  } catch {
    // ignore
  }
  return ".webp";
};

const withConcurrency = async (items, limit, worker) => {
  const queue = [...items];
  const running = [];

  const launch = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      await worker(item);
    }
  };

  const count = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < count; i += 1) {
    running.push(launch());
  }
  await Promise.all(running);
};

const loadPreviousManifest = async () => {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const main = async () => {
  const opts = parseArgs();
  const channels = [...new Set(opts.channels.map((v) => v.toLowerCase()))].slice(0, 12);

  console.log(`[emotes] API: ${opts.apiBase}`);
  console.log(`[emotes] Services: ${opts.services}`);
  console.log(`[emotes] Channels: ${channels.join(", ")}`);
  console.log(`[emotes] Download assets: ${opts.download ? "yes" : "no"}`);

  if (opts.clean) {
    await rm(PUBLIC_EMOTES_DIR, { recursive: true, force: true });
  }
  await mkdir(PUBLIC_EMOTES_DIR, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });

  const collected = [];

  try {
    const global = await fetchJson(
      `${opts.apiBase}/global/emotes/${encodeURIComponent(opts.services)}`,
    );
    collected.push(...mapTemotesEmotes(global, 20, "global"));
    console.log(`[emotes] Global fetched: ${Array.isArray(global) ? global.length : 0}`);
  } catch (error) {
    console.warn(`[emotes] Global fetch failed: ${error.message}`);
  }

  for (let i = 0; i < channels.length; i += 1) {
    const channel = channels[i];
    try {
      const payload = await fetchJson(
        `${opts.apiBase}/channel/${encodeURIComponent(channel)}/emotes/${encodeURIComponent(
          opts.services,
        )}`,
      );
      const priority = 80 - i;
      collected.push(...mapTemotesEmotes(payload, priority, `channel:${channel}`));
      console.log(
        `[emotes] Channel ${channel} fetched: ${Array.isArray(payload) ? payload.length : 0}`,
      );
    } catch (error) {
      console.warn(`[emotes] Channel ${channel} fetch failed: ${error.message}`);
    }
  }

  const deduped = new Map();
  for (const emote of collected) {
    upsert(deduped, emote);
  }

  const scoreRecord = (record) => {
    const aliasBoost = ALWAYS_INCLUDE_CODES.has(record.code) ? 1000 : 0;
    const globalBoost = record.source === "global" ? 20 : 0;
    return record.priority + aliasBoost + globalBoost;
  };

  const records = Array.from(deduped.values())
    .sort((a, b) => scoreRecord(b) - scoreRecord(a) || a.code.localeCompare(b.code))
    .slice(0, opts.max)
    .sort((a, b) => a.code.localeCompare(b.code));

  console.log(`[emotes] Resolved unique emotes: ${records.length}`);

  if (opts.download) {
    await withConcurrency(records, opts.concurrency, async (record) => {
      const sourceUrl = toAbsoluteUrl(record.url);
      const ext = detectExtension(sourceUrl);
      const hash = createHash("sha1").update(sourceUrl).digest("hex").slice(0, 12);
      const fileName = `${safeFilePart(record.code)}-${hash}${ext}`;
      const providerDir = path.join(ASSETS_DIR, record.provider);
      const filePath = path.join(providerDir, fileName);
      const publicPath = `/emotes/assets/${record.provider}/${fileName}`;

      await mkdir(providerDir, { recursive: true });
      if (!(await fileExists(filePath))) {
        try {
          const response = await fetch(sourceUrl);
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          await writeFile(filePath, buffer);
        } catch (error) {
          console.warn(`[emotes] Asset download failed for ${record.code}: ${error.message}`);
          return;
        }
      }

      record.url = publicPath;
    });
  }

  const previous = await loadPreviousManifest();
  const previousCount = Array.isArray(previous?.emotes) ? previous.emotes.length : 0;

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    channels,
    services: opts.services,
    emotes: records,
  };

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`[emotes] Manifest written: ${MANIFEST_PATH}`);
  console.log(`[emotes] Previous count: ${previousCount}, new count: ${records.length}`);
};

main().catch((error) => {
  console.error(`[emotes] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
