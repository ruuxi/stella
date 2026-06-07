#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const requestPath = path.join(repoRoot, ".stella-selfmod-replay-request.json");
const resultPath = path.join(repoRoot, ".stella-selfmod-replay-result.json");
const delayMs = Number(process.env.STELLA_REPLAY_DELAY_MS ?? "1000");
const timeoutMs = Number(process.env.STELLA_REPLAY_TIMEOUT_MS ?? "45000");
const mode = process.argv.includes("--reload")
  ? "reload"
  : process.env.STELLA_REPLAY_MODE === "reload"
    ? "reload"
    : "hmr";
const id = String(Date.now());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This script is a replay client only. It needs the temporary host-side
// request watcher described in docs/self-mod-morph-replay.md.
const readMatchingResult = async () => {
  const raw = await fs.readFile(resultPath, "utf8").catch(() => "");
  if (!raw.trim()) return null;
  const result = JSON.parse(raw);
  return result.id === id ? result : null;
};

await fs.rm(resultPath, { force: true });
await fs.writeFile(
  requestPath,
  JSON.stringify({ id, delayMs, mode }, null, 2),
);

console.log(`[replay] requested host-side interstellar self-mod mode=${mode} id=${id}`);
console.log(`[replay] waiting for ${path.relative(repoRoot, resultPath)}`);

const startedAt = Date.now();
while (Date.now() - startedAt < timeoutMs) {
  const result = await readMatchingResult();
  if (result) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    process.exit(0);
  }
  await wait(250);
}

console.error(`[replay] timed out after ${timeoutMs}ms`);
process.exit(1);
