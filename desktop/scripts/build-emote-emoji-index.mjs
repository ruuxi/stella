#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LABELS_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "emoji-labels.json");
const DEFAULT_INDEX_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "emoji-index.json");

const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/u;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {
    labelsPath: DEFAULT_LABELS_PATH,
    outputPath: DEFAULT_INDEX_PATH,
    minConfidence: 0,
  };

  for (const arg of args) {
    if (arg.startsWith("--labels=")) {
      opts.labelsPath = path.resolve(arg.slice("--labels=".length));
      continue;
    }
    if (arg.startsWith("--output=")) {
      opts.outputPath = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--min-confidence=")) {
      const parsed = Number.parseFloat(arg.slice("--min-confidence=".length));
      if (Number.isFinite(parsed)) {
        opts.minConfidence = parsed;
      }
    }
  }

  return opts;
};

const extractSingleEmoji = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(EMOJI_RE);
  return match?.[0] ?? null;
};

const main = async () => {
  const opts = parseArgs();
  const raw = await readFile(opts.labelsPath, "utf8");
  const parsed = JSON.parse(raw);
  const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];

  const entries = [];
  const emojiMap = new Map();

  for (const label of labels) {
    const code = typeof label?.code === "string" ? label.code : "";
    const emoji = extractSingleEmoji(label?.emoji ?? "");
    const confidence = Number.isFinite(label?.confidence) ? Number(label.confidence) : 0;
    if (!code || !emoji || confidence < opts.minConfidence) {
      continue;
    }

    const entry = {
      code,
      emoji,
      confidence,
      provider: label.provider ?? "unknown",
      animated: Boolean(label.animated),
      url: label.url ?? "",
    };
    entries.push(entry);

    const list = emojiMap.get(emoji);
    if (list) {
      list.push(entry);
    } else {
      emojiMap.set(emoji, [entry]);
    }
  }

  entries.sort((a, b) => a.code.localeCompare(b.code));

  const byEmoji = Array.from(emojiMap.entries())
    .map(([emoji, list]) => ({
      emoji,
      codes: [...list]
        .sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code))
        .map((entry) => entry.code),
    }))
    .sort((a, b) => a.emoji.localeCompare(b.emoji));

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    labelsSource: path.relative(FRONTEND_ROOT, opts.labelsPath),
    minConfidence: opts.minConfidence,
    entries,
    byEmoji,
  };

  await writeFile(opts.outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log(`[index] Labels input: ${opts.labelsPath}`);
  console.log(`[index] Entries written: ${entries.length}`);
  console.log(`[index] Unique emojis: ${byEmoji.length}`);
  console.log(`[index] Output: ${opts.outputPath}`);
};

main().catch((error) => {
  console.error(`[index] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
