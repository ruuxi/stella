#!/usr/bin/env node
// One-time deep-consolidation report for the MEMORY.md lifecycle migration
// (design review §6.2d / migration step "MEMORY.md supersede/rotation
// lifecycle" — the supervised Codex-INIT-analog pass).
//
// STRICTLY READ-ONLY against the memories directory. The mechanical half of
// the deep pass (bounding the oversized active file) is subsumed by the
// runtime's automatic size rotation, which brings the file under threshold on
// the first completed Dream pass after upgrade. What cannot be mechanical is
// the MERGE of superseded near-duplicate blocks — that is LLM/operator
// judgment. This script produces the supervised worklist for it:
//
//   - active-file size vs the rotation threshold/target, and a preview of
//     which blocks automatic rotation will move to which period archives;
//   - clusters of blocks whose titles indicate the same workstream (the
//     "ff saga smears across ≥3 near-duplicate blocks in one day" class),
//     for a supervised operator (or a manual Dream run under the normal
//     StrReplace jail) to merge via the supersede rule;
//   - retired-file status (memory_summary.md / memory_index.md are preserved
//     and never injected; nothing further to delete).
//
// Usage:
//   node runtime/scripts/memory-deep-consolidation-report.mjs \
//     [--memories-dir ~/.stella/memories] [--out report.md]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Keep in sync with runtime/kernel/memory/memory-rotation.ts (the script is
// standalone .mjs and cannot import the TS module).
const ROTATION_THRESHOLD_BYTES = 300_000;
const ROTATION_TARGET_BYTES = 240_000;
const MIN_ACTIVE_BLOCKS = 5;

const ACTIVE_START = "<!-- DREAM:ACTIVE_BLOCKS_START -->";
const ACTIVE_END = "<!-- DREAM:ACTIVE_BLOCKS_END -->";
const ARCHIVE_START = "<!-- DREAM:ARCHIVE_START -->";
const ARCHIVE_END = "<!-- DREAM:ARCHIVE_END -->";
const BLOCK_DATE_RE = /^## (\d{4}-\d{2}-\d{2})/u;

const args = process.argv.slice(2);
const readArg = (flag) => {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
};
const expandHome = (p) => (p?.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

const memoriesDir = expandHome(readArg("--memories-dir")) ??
  path.join(os.homedir(), ".stella", "memories");
const outPath = expandHome(readArg("--out"));

const readOptional = (p) => {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

const sliceBetween = (raw, startAnchor, endAnchor) => {
  const start = raw.indexOf(startAnchor);
  const end = raw.indexOf(endAnchor);
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start + startAnchor.length, end);
};

const parseBlocks = (body, section) => {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.join("\n").trim();
    if (text) {
      const heading = text.split("\n", 1)[0];
      const date = BLOCK_DATE_RE.exec(text)?.[1];
      blocks.push({ text, heading, date, section });
    }
    current = null;
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return blocks;
};

const archiveFileForDate = (isoDate) => {
  const [year, month] = isoDate.split("-");
  return `MEMORY-${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}.md`;
};

const normalizedTitle = (heading) =>
  heading
    .replace(/^## /u, "")
    .replace(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?\s*[—-]?\s*/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const titleWordOverlap = (a, b) => {
  const wordsA = new Set(a.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(b.split(" ").filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared += 1;
  return shared / Math.min(wordsA.size, wordsB.size);
};

const lines = [];
const emit = (line = "") => lines.push(line);

const memoryPath = path.join(memoriesDir, "MEMORY.md");
const raw = readOptional(memoryPath);
emit(`# MEMORY.md deep-consolidation report`);
emit();
emit(`- generated: ${new Date().toISOString()}`);
emit(`- memories dir: ${memoriesDir}`);
emit();

if (raw === null) {
  emit(`MEMORY.md not found — nothing to analyze.`);
} else {
  const bytes = Buffer.byteLength(raw, "utf-8");
  const activeBody = sliceBetween(raw, ACTIVE_START, ACTIVE_END);
  const archiveBody = sliceBetween(raw, ARCHIVE_START, ARCHIVE_END) ?? "";
  emit(`## Size and rotation`);
  emit();
  emit(
    `- active file: ${bytes.toLocaleString()} bytes (rotation threshold ${ROTATION_THRESHOLD_BYTES.toLocaleString()}, target ${ROTATION_TARGET_BYTES.toLocaleString()})`,
  );
  if (activeBody === null) {
    emit(
      `- WARNING: DREAM:ACTIVE_BLOCKS anchors missing or out of order — automatic rotation will refuse this file until the anchors are restored.`,
    );
  } else {
    const activeBlocks = parseBlocks(activeBody, "active");
    const archiveBlocks = parseBlocks(archiveBody, "archive");
    const undated = [...activeBlocks, ...archiveBlocks].filter((b) => !b.date);
    emit(
      `- blocks: ${activeBlocks.length} active, ${archiveBlocks.length} in the in-file Archive section, ${undated.length} undated (undated blocks never rotate)`,
    );
    // Preview of what the shipped automatic rotation would move.
    const candidates = [
      ...archiveBlocks.filter((b) => b.date),
      ...activeBlocks.filter((b) => b.date).slice(MIN_ACTIVE_BLOCKS).reverse(),
    ];
    let projected = bytes;
    const plan = new Map();
    for (const block of candidates) {
      if (projected <= ROTATION_TARGET_BYTES) break;
      projected -= Buffer.byteLength(block.text, "utf-8");
      const file = archiveFileForDate(block.date);
      plan.set(file, (plan.get(file) ?? 0) + 1);
    }
    if (bytes <= ROTATION_THRESHOLD_BYTES) {
      emit(`- under threshold: automatic rotation will not fire.`);
    } else if (plan.size === 0) {
      emit(`- over threshold but nothing rotatable (dated blocks exhausted).`);
    } else {
      emit(`- automatic rotation preview (fires after the next completed Dream pass):`);
      for (const [file, count] of [...plan.entries()].sort()) {
        emit(`    - ${count} block(s) → archive/${file}`);
      }
      emit(`    - projected active size after: ~${projected.toLocaleString()} bytes`);
    }

    emit();
    emit(`## Near-duplicate merge worklist (supervised)`);
    emit();
    const dated = activeBlocks.filter((b) => b.date);
    const clusters = new Map();
    for (const block of dated) {
      const key = normalizedTitle(block.heading);
      if (!key) continue;
      const cluster = clusters.get(key) ?? [];
      cluster.push(block);
      clusters.set(key, cluster);
    }
    const exact = [...clusters.entries()].filter(([, list]) => list.length > 1);
    if (exact.length === 0) {
      emit(`- no exact-title clusters among active dated blocks.`);
    } else {
      for (const [key, list] of exact) {
        emit(`- "${key}" × ${list.length}:`);
        for (const block of list) emit(`    - ${block.heading}`);
      }
    }
    const keys = [...clusters.keys()];
    const similar = [];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        if (titleWordOverlap(keys[i], keys[j]) >= 0.6) {
          similar.push([keys[i], keys[j]]);
        }
      }
    }
    if (similar.length > 0) {
      emit();
      emit(`- similar-title pairs (review for the same workstream):`);
      for (const [a, b] of similar.slice(0, 40)) emit(`    - "${a}" ↔ "${b}"`);
    }
    emit();
    emit(
      `Merge procedure: for each cluster, have a supervised Dream run (or an operator) rewrite the newest block to carry the workstream's current state and delete the older near-duplicates via StrReplace — the jail preserves every removed span in archive/MEMORY-superseded.md automatically, so the merge is non-destructive by construction.`,
    );
  }
}

emit();
emit(`## Retired files`);
emit();
for (const name of ["memory_summary.md", "memory_index.md"]) {
  const content = readOptional(path.join(memoriesDir, name));
  if (content === null) {
    emit(`- ${name}: absent (fresh install after the map migration).`);
  } else {
    const retired = content.startsWith("<!-- RETIRED");
    const hasRetiredSection = content.includes("DREAM:RETIRED_SUMMARY");
    emit(
      `- ${name}: present, ${content.length.toLocaleString()} chars, ${retired ? "retirement banner in place" : "NO retirement banner (pre-migration file)"}${hasRetiredSection ? ", contains the retired-summary comment (preserved; never injected — comment stripping removes it from every read surface)" : ""}.`,
    );
  }
}

const report = lines.join("\n") + "\n";
if (outPath) {
  fs.writeFileSync(outPath, report, "utf-8");
  console.log(`Report written to ${outPath}`);
} else {
  console.log(report);
}
