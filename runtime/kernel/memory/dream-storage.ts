/**
 * On-disk markdown layout the Dream agent edits.
 *
 * The Dream agent never CREATES these files — `ensureDreamMemoryLayout` seeds
 * them with stable templates the first time the scheduler runs (or on
 * startup). The agent then surgically edits them via StrReplace using the
 * unique anchor markers below.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_SUMMARY_FILE = "memory_summary.md";
export const RAW_MEMORIES_FILE = "raw_memories.md";

const MEMORY_TEMPLATE = `# MEMORY

> Canonical task-group ledger maintained by the Dream agent. Newest blocks at
> the top. Each block describes one cohesive task or thread the user has been
> working on. Stale blocks (>30 days, superseded) are moved under the trailing
> Archive heading instead of being deleted.
>
> Schema for each block (do not break the format):
>
>     ## <YYYY-MM-DD HH:MM> — <short title>
>     Threads: <thread_id>:<run_id>, ...
>     Why this matters: <one sentence>
>     Outcome: <what shipped, what is pending>
>     Recall hooks: <comma-separated keywords>

<!-- DREAM:ACTIVE_BLOCKS_START -->
<!-- DREAM:ACTIVE_BLOCKS_END -->

## Archive

<!-- DREAM:ARCHIVE_START -->
<!-- DREAM:ARCHIVE_END -->
`;

const MEMORY_SUMMARY_TEMPLATE = `# Memory summary

> Short, dynamic snapshot of the user's currently active focus. Rewritten by
> the Dream agent when focus shifts. Target ~10-20 lines max. Loaded on every
> Orchestrator turn.

<!-- DREAM:SUMMARY_START -->
- No active focus recorded yet.
<!-- DREAM:SUMMARY_END -->
`;

const RAW_MEMORIES_TEMPLATE = `# Raw memories

> Flat append-only routing layer. New entries land under Unprocessed; once the
> Dream agent has folded them into MEMORY.md they are moved to Processed.

## Unprocessed

<!-- DREAM:RAW_UNPROCESSED_START -->
<!-- DREAM:RAW_UNPROCESSED_END -->

## Processed

<!-- DREAM:RAW_PROCESSED_START -->
<!-- DREAM:RAW_PROCESSED_END -->
`;

export const memoriesRoot = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "memories");

export const memoryFilePath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_FILE);

export const memorySummaryPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_SUMMARY_FILE);

export const rawMemoriesPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), RAW_MEMORIES_FILE);

const writeIfMissing = async (target: string, contents: string): Promise<void> => {
  try {
    await fs.access(target);
  } catch {
    await fs.writeFile(target, contents, "utf-8");
  }
};

export const ensureDreamMemoryLayout = async (
  stellaDataDir: string,
): Promise<void> => {
  const root = memoriesRoot(stellaDataDir);
  await fs.mkdir(root, { recursive: true });
  await writeIfMissing(memoryFilePath(stellaDataDir), MEMORY_TEMPLATE);
  await writeIfMissing(memorySummaryPath(stellaDataDir), MEMORY_SUMMARY_TEMPLATE);
  await writeIfMissing(rawMemoriesPath(stellaDataDir), RAW_MEMORIES_TEMPLATE);
};

export const readMemoryFile = async (
  stellaDataDir: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(memoryFilePath(stellaDataDir), "utf-8");
  } catch {
    return null;
  }
};

export const readMemorySummary = async (
  stellaDataDir: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(memorySummaryPath(stellaDataDir), "utf-8");
  } catch {
    return null;
  }
};
