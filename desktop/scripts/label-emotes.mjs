#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway, generateText } from "ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");

const DEFAULT_MANIFEST_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "manifest.json");
const DEFAULT_OUTPUT_PATH = path.join(FRONTEND_ROOT, "public", "emotes", "emoji-labels.json");
const DEFAULT_MODEL = "google/gemini-3-flash";
const DEFAULT_LAUNCH_EVERY_MS = 100;
const DEFAULT_MAX_INFLIGHT = 48;
const DEFAULT_MAX_OUTPUT_TOKENS = 40;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_RETRIES = 2;

const KEY_SOURCE_FILES = [
  path.join(REPO_ROOT, "testing-folder", "memory-tests", "config.ts"),
  path.join(REPO_ROOT, "testing-folder", "jailbreak-tests", "config.ts"),
  path.join(REPO_ROOT, "testing-folder", "jailbreak-tests-realistic", "config.ts"),
];

const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/u;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    model: process.env.EMOTE_LABEL_MODEL?.trim() || DEFAULT_MODEL,
    launchEveryMs: DEFAULT_LAUNCH_EVERY_MS,
    rpm: null,
    maxInflight: DEFAULT_MAX_INFLIGHT,
    retries: DEFAULT_RETRIES,
    limit: null,
    offset: 0,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    resume: true,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--no-resume") {
      opts.resume = false;
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      opts.manifestPath = path.resolve(arg.slice("--manifest=".length));
      continue;
    }
    if (arg.startsWith("--output=")) {
      opts.outputPath = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--model=")) {
      opts.model = arg.slice("--model=".length).trim();
      continue;
    }
    if (arg.startsWith("--launch-every-ms=")) {
      const parsed = Number.parseInt(arg.slice("--launch-every-ms=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.launchEveryMs = parsed;
      }
      continue;
    }
    if (arg.startsWith("--rpm=")) {
      const parsed = Number.parseInt(arg.slice("--rpm=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.rpm = parsed;
      }
      continue;
    }
    if (arg.startsWith("--max-inflight=")) {
      const parsed = Number.parseInt(arg.slice("--max-inflight=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.maxInflight = parsed;
      }
      continue;
    }
    if (arg.startsWith("--retries=")) {
      const parsed = Number.parseInt(arg.slice("--retries=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        opts.retries = parsed;
      }
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.limit = parsed;
      }
      continue;
    }
    if (arg.startsWith("--offset=")) {
      const parsed = Number.parseInt(arg.slice("--offset=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        opts.offset = parsed;
      }
      continue;
    }
    if (arg.startsWith("--max-output-tokens=")) {
      const parsed = Number.parseInt(arg.slice("--max-output-tokens=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.maxOutputTokens = parsed;
      }
      continue;
    }
    if (arg.startsWith("--temperature=")) {
      const parsed = Number.parseFloat(arg.slice("--temperature=".length));
      if (Number.isFinite(parsed)) {
        opts.temperature = parsed;
      }
    }
  }

  if (opts.rpm) {
    opts.launchEveryMs = Math.max(1, Math.floor(60000 / opts.rpm));
  }

  return opts;
};

const extractKeyFromSource = async (filePath) => {
  try {
    const content = await readFile(filePath, "utf8");
    const match = content.match(/AI_GATEWAY_API_KEY\s*=\s*"([^"]+)"/);
    const key = match?.[1]?.trim();
    if (key && key !== "YOUR_KEY_HERE") {
      return key;
    }
  } catch {
    // ignore
  }
  return null;
};

const resolveApiKey = async () => {
  const envKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (envKey) {
    return { key: envKey, source: "env" };
  }

  for (const sourcePath of KEY_SOURCE_FILES) {
    const fileKey = await extractKeyFromSource(sourcePath);
    if (fileKey) {
      process.env.AI_GATEWAY_API_KEY = fileKey;
      return { key: fileKey, source: path.relative(REPO_ROOT, sourcePath) };
    }
  }

  throw new Error("AI_GATEWAY_API_KEY not found in env or testing-folder config files.");
};

const loadJson = async (filePath) => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const toLocalImagePath = (manifestUrl) => {
  if (typeof manifestUrl !== "string") return null;
  if (!manifestUrl.startsWith("/")) return null;
  return path.join(FRONTEND_ROOT, "public", manifestUrl.slice(1));
};

const loadImageDataPart = async (record) => {
  const localPath = toLocalImagePath(record.url);
  if (!localPath) return null;
  try {
    await stat(localPath);
    return await readFile(localPath);
  } catch {
    return null;
  }
};

const extractSingleEmoji = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(EMOJI_RE);
  return match?.[0] ?? null;
};

const fallbackEmojiFromCode = (code) => {
  const normalized = String(code).toLowerCase();
  if (/sad|cry|feelsbad|depress|dead/.test(normalized)) return "😢";
  if (/love|heart|kiss/.test(normalized)) return "❤️";
  if (/laugh|lol|kekw|lmao/.test(normalized)) return "😂";
  if (/angry|mad|rage/.test(normalized)) return "😠";
  if (/think|hmm/.test(normalized)) return "🤔";
  if (/pog|hype|wow|party/.test(normalized)) return "✨";
  if (/fire|lit|hot/.test(normalized)) return "🔥";
  if (/cat|dog|frog|pepe|monka/.test(normalized)) return "🐸";
  return "🙂";
};

const buildPromptText = (record) => {
  return [
    "You are labeling a Twitch emote image.",
    "Return exactly ONE Unicode emoji that best matches this emote.",
    "Output only the emoji, nothing else.",
    `emote_code: ${record.code}`,
    `provider: ${record.provider ?? "unknown"}`,
    `animated: ${record.animated ? "true" : "false"}`,
  ].join("\n");
};

const loadManifestEntries = async (manifestPath) => {
  const manifest = await loadJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.emotes)) {
    throw new Error(`Invalid manifest: ${manifestPath}`);
  }
  return manifest.emotes
    .filter((record) => record && typeof record.code === "string" && typeof record.url === "string")
    .map((record) => ({
      code: record.code,
      url: record.url,
      provider: record.provider ?? "unknown",
      animated: Boolean(record.animated),
    }));
};

const loadExistingLabels = async (outputPath) => {
  const parsed = await loadJson(outputPath);
  if (!parsed || !Array.isArray(parsed.labels)) {
    return new Map();
  }
  const map = new Map();
  for (const label of parsed.labels) {
    if (label && typeof label.code === "string" && typeof label.emoji === "string") {
      map.set(label.code, label);
    }
  }
  return map;
};

const writeLabelsFile = async ({ outputPath, model, launchEveryMs, maxInflight, labelsMap }) => {
  const labels = Array.from(labelsMap.values()).sort((a, b) => a.code.localeCompare(b.code));
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    model,
    pacing: {
      launchEveryMs,
      effectiveMaxRpm: Math.round(60000 / launchEveryMs),
      maxInflight,
    },
    labels,
  };
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
};

const withRetry = async (fn, retries) => {
  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt <= retries) {
        await sleep(150 * attempt);
      }
    }
  }
  throw lastError;
};

const main = async () => {
  const opts = parseArgs();

  const allEntries = await loadManifestEntries(opts.manifestPath);
  const labelsMap = opts.resume ? await loadExistingLabels(opts.outputPath) : new Map();

  const sliced = allEntries.slice(opts.offset, opts.limit ? opts.offset + opts.limit : undefined);
  const pending = sliced.filter((entry) => !labelsMap.has(entry.code));

  console.log(`[labels] Manifest entries: ${allEntries.length}`);
  console.log(`[labels] Selection: ${sliced.length} (offset=${opts.offset}, limit=${opts.limit ?? "all"})`);
  console.log(`[labels] Already labeled: ${labelsMap.size}`);
  console.log(`[labels] Pending: ${pending.length}`);
  console.log(
    `[labels] Pacing: launch every ${opts.launchEveryMs}ms (max ${Math.round(
      60000 / opts.launchEveryMs,
    )}/min), max inflight=${opts.maxInflight}`,
  );
  console.log(`[labels] Model: ${opts.model}`);

  if (opts.dryRun || pending.length === 0) {
    if (opts.dryRun) {
      console.log("[labels] Dry run complete.");
    }
    if (pending.length === 0) {
      console.log("[labels] Nothing to label.");
    }
    return;
  }

  const { key: apiKey, source } = await resolveApiKey();
  const gateway = createGateway({ apiKey });
  console.log(`[labels] API key source: ${source}`);

  let succeeded = 0;
  let failed = 0;
  let launched = 0;
  let completed = 0;
  const errors = [];
  const inflight = new Set();

  const runLabel = async (record) => {
    return withRetry(async () => {
      const imageData = await loadImageDataPart(record);
      if (!imageData || imageData.length === 0) {
        throw new Error(`Missing image data for ${record.code}`);
      }

      const result = await generateText({
        model: gateway(opts.model),
        temperature: opts.temperature,
        maxOutputTokens: opts.maxOutputTokens,
        providerOptions: { gateway: {} },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPromptText(record) },
              { type: "image", image: imageData },
            ],
          },
        ],
      });

      const emoji = extractSingleEmoji(result.text) ?? fallbackEmojiFromCode(record.code);
      labelsMap.set(record.code, {
        code: record.code,
        url: record.url,
        provider: record.provider,
        animated: record.animated,
        emoji,
        confidence: 0.55,
        model: opts.model,
        labeledAt: new Date().toISOString(),
      });
    }, opts.retries);
  };

  const maybeFlush = async (force = false) => {
    if (!force && completed % 50 !== 0) {
      return;
    }
    await writeLabelsFile({
      outputPath: opts.outputPath,
      model: opts.model,
      launchEveryMs: opts.launchEveryMs,
      maxInflight: opts.maxInflight,
      labelsMap,
    });
  };

  for (const record of pending) {
    while (inflight.size >= opts.maxInflight) {
      await Promise.race(inflight);
    }

    launched += 1;
    const task = runLabel(record)
      .then(() => {
        succeeded += 1;
      })
      .catch((error) => {
        failed += 1;
        errors.push({
          code: record.code,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(async () => {
        completed += 1;
        inflight.delete(task);
        if (completed % 25 === 0 || completed === pending.length) {
          console.log(
            `[labels] Progress: ${completed}/${pending.length} (ok=${succeeded}, failed=${failed}, inflight=${inflight.size})`,
          );
        }
        await maybeFlush();
      });

    inflight.add(task);
    await sleep(opts.launchEveryMs);
  }

  await Promise.all(inflight);
  await maybeFlush(true);

  console.log(
    `[labels] Done. launched=${launched}, succeeded=${succeeded}, failed=${failed}, output=${opts.outputPath}`,
  );
  if (errors.length > 0) {
    const errorPath = `${opts.outputPath}.errors.json`;
    await writeFile(errorPath, JSON.stringify(errors, null, 2) + "\n", "utf8");
    console.log(`[labels] Errors written: ${errorPath}`);
  }
};

main().catch((error) => {
  console.error(`[labels] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
