/**
 * Resident startup docs — the always-loaded files (personality, core memory,
 * user profile, Dream memory summary, registry) that ride the orchestrator
 * window as pinned `bootstrap.startup_doc` messages.
 *
 * Injection contract (prompt-cache preservation): exactly ONE persisted copy
 * per doc path rides a thread, and its bytes NEVER change between compaction
 * boundaries. Mid-epoch rewrites of the underlying files (a Dream pass, a
 * Remember call) do not re-inject or mutate the pinned copy — the live window
 * already contains that information as ordinary messages, and any head
 * mutation would invalidate the provider prompt cache for the whole prefix.
 * Durable docs catch up at the next compaction/rebuild boundary, where the
 * prefix is being rebuilt (and the cache invalidated) anyway — see
 * {@link refreshResidentStartupDocs}.
 *
 * This module is intentionally dependency-light (fs/path/redaction/dream
 * constants only) so both `thread-runtime.ts` and `runner/shared.ts` can use
 * it without the runner→agent-manager→session→thread-runtime module cycle.
 */

import fs from "node:fs";
import path from "node:path";
import { redactMemoryText } from "./redaction.js";
import { MEMORY_INDEX_MAX_CHARS } from "./dream-storage.js";
import type { RuntimeStore } from "../storage/runtime-store.js";

export const LIFE_REGISTRY_DISPLAY_PATH = "~/.stella/registry.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const LIFE_MEMORY_SUMMARY_DISPLAY_PATH =
  "~/.stella/memories/memory_summary.md";
export const LIFE_MEMORY_INDEX_DISPLAY_PATH =
  "~/.stella/memories/memory_index.md";
export const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";

/**
 * Strip HTML comment blocks from a memory doc before it is injected into
 * model context. Dream's archival convention wraps retired content in
 * comments (e.g. the DREAM:RETIRED_SUMMARY block — measured live at 27.6KB,
 * 100% re-compressions of MEMORY.md blocks), and injecting an archive costs
 * tokens and crowds the real content out of the injection cap. Comments stay
 * on disk untouched; only injected views drop them. An unterminated `<!--`
 * is stripped through end-of-doc so a malformed comment can't leak the
 * graveyard back into context.
 */
export const stripInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--[\s\S]*$/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

export const MEMORY_SUMMARY_BOOTSTRAP_MAX_CHARS = 12_000;
const MEMORY_SUMMARY_TRUNCATION_MARKER =
  "\n...[resident memory summary truncated]";

/** Hard cap applied to the memory summary before it becomes a startup doc. */
export const capBootstrapMemorySummary = (summary: string): string =>
  summary.length > MEMORY_SUMMARY_BOOTSTRAP_MAX_CHARS
    ? `${summary.slice(
        0,
        MEMORY_SUMMARY_BOOTSTRAP_MAX_CHARS -
          MEMORY_SUMMARY_TRUNCATION_MARKER.length,
      )}${MEMORY_SUMMARY_TRUNCATION_MARKER}`
    : summary;

export const buildStartupDocMessage = (
  displayPath: string,
  content: string,
): string =>
  [`<startup_doc path="${displayPath}">`, content, "</startup_doc>"].join("\n");

const STARTUP_DOC_PATH_PATTERN = /^<startup_doc path="([^"]+)">/u;

/** Extract the display path a persisted startup-doc message was built with. */
export const parseStartupDocPath = (docText: string): string | undefined =>
  STARTUP_DOC_PATH_PATTERN.exec(docText.trim())?.[1];

const capResidentMemoryDoc = (content: string, maxChars?: number): string => {
  if (!maxChars || content.length <= maxChars) return content;
  const marker = "\n...[resident memory truncated]";
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
};

const readResidentMemoryDoc = (
  filePath: string,
  maxChars?: number,
): string | undefined => {
  try {
    // Comments are stripped BEFORE the cap so retired archive blocks can
    // never consume injection budget or push live entries past the cap.
    const content = stripInjectedHtmlComments(
      fs.readFileSync(filePath, "utf-8"),
    );
    return content
      ? capResidentMemoryDoc(redactMemoryText(content), maxChars)
      : undefined;
  } catch {
    return undefined;
  }
};

export const readCoreMemory = (stellaDataDir: string): string | undefined => {
  const candidatePaths = [
    path.join(stellaDataDir, "core-memory.md"),
    path.join(stellaDataDir, "CORE_MEMORY.MD"),
  ];
  for (const filePath of candidatePaths) {
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        return redactMemoryText(content);
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

/**
 * Dream's dynamic focus summary, read synchronously for resident injection.
 * Push-injected alongside core memory so the user's current active focus is
 * always in the Orchestrator's context (not only via the `Context` lookup).
 * Summary only — the routing index is a separate doc with its own path label
 * ({@link readMemoryIndexDoc}), so summary truncation can never silently
 * swallow the index and the model can cite each source distinctly.
 */
export const readMemorySummaryDoc = (
  stellaDataDir: string,
): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "memory_summary.md"),
  );

/**
 * Dream's routing index (what memory contains and where to find it), read
 * synchronously for resident injection under its own path label.
 */
export const readMemoryIndexDoc = (
  stellaDataDir: string,
): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "memory_index.md"),
    MEMORY_INDEX_MAX_CHARS,
  );

/**
 * The durable user-profile facts written by the `Remember` tool, read
 * synchronously for resident injection.
 */
export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(path.join(stellaDataDir, "memories", "profile.md"));

const readOptionalTextFileSync = (filePath: string): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Re-derive the exact injectable body for a pinned startup doc from disk,
 * applying the same transformation chain the injection path applies to its
 * context field, so a refreshed copy is byte-identical to what a fresh
 * injection would produce for the same disk state.
 *
 * Personality is read verbatim (no seeding here — the pinned copy only exists
 * because a seeded read already happened on the thread's first turn).
 */
export const readStartupDocBodyFromDisk = (
  stellaDataDir: string,
  displayPath: string,
): string | undefined => {
  switch (displayPath) {
    case LIFE_PERSONALITY_DISPLAY_PATH:
      return readOptionalTextFileSync(
        path.join(stellaDataDir, "PERSONALITY.md"),
      );
    case LIFE_REGISTRY_DISPLAY_PATH:
      return readOptionalTextFileSync(path.join(stellaDataDir, "registry.md"));
    case LIFE_CORE_MEMORY_DISPLAY_PATH: {
      const coreMemory = readCoreMemory(stellaDataDir);
      return coreMemory ? redactMemoryText(coreMemory.trim()) : undefined;
    }
    case LIFE_USER_PROFILE_DISPLAY_PATH: {
      const userProfile = readUserProfileDoc(stellaDataDir);
      return userProfile ? redactMemoryText(userProfile.trim()) : undefined;
    }
    case LIFE_MEMORY_SUMMARY_DISPLAY_PATH: {
      const memorySummary = readMemorySummaryDoc(stellaDataDir);
      return memorySummary
        ? capBootstrapMemorySummary(redactMemoryText(memorySummary.trim()))
        : undefined;
    }
    case LIFE_MEMORY_INDEX_DISPLAY_PATH: {
      const memoryIndex = readMemoryIndexDoc(stellaDataDir);
      return memoryIndex ? redactMemoryText(memoryIndex.trim()) : undefined;
    }
    default:
      return undefined;
  }
};

const customMessageText = (
  content: string | Array<{ type: string; text?: string }>,
): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("\n");

/**
 * Compaction/rebuild-boundary refresh of the pinned resident-doc copies.
 *
 * Called from `maybeCompactRuntimeThread` immediately after a compaction
 * overlay is written — the one moment the prompt prefix is being rebuilt and
 * the provider cache is already invalidated, so updating persisted head
 * entries costs nothing extra. Every surviving `bootstrap.startup_doc` entry
 * whose source file changed is rewritten in place from disk (same entry id,
 * same position — the pin holds). A missing/empty source keeps the existing
 * copy rather than blanking context.
 *
 * MUST NOT be called outside a compaction/rebuild boundary: mid-epoch it
 * would mutate the prompt prefix and break cache stability.
 */
export const refreshResidentStartupDocs = (args: {
  store: RuntimeStore;
  threadKey: string;
  stellaDataDir: string;
}): number => {
  const messages = args.store.loadThreadMessages(args.threadKey);
  let refreshedCount = 0;
  for (const message of messages) {
    const customMessage = message.customMessage;
    if (
      message.role !== "runtimeInternal" ||
      customMessage?.customType !== BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE ||
      !message.entryId
    ) {
      continue;
    }
    const persistedDoc = customMessageText(customMessage.content);
    const displayPath = parseStartupDocPath(persistedDoc);
    if (!displayPath) {
      continue;
    }
    const freshBody = readStartupDocBodyFromDisk(
      args.stellaDataDir,
      displayPath,
    );
    if (!freshBody) {
      continue;
    }
    const freshDoc = buildStartupDocMessage(displayPath, freshBody);
    if (freshDoc.trim() === persistedDoc.trim()) {
      continue;
    }
    const updated = args.store.updateThreadCustomMessageContent({
      threadKey: args.threadKey,
      entryId: message.entryId,
      content: [{ type: "text", text: freshDoc }],
    });
    if (updated) {
      refreshedCount += 1;
    }
  }
  return refreshedCount;
};
