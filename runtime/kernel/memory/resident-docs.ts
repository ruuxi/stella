/**
 * Resident startup docs — the always-loaded files (personality, core memory,
 * user profile, Dream memory map, registry) that ride the orchestrator
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
 * Retired docs (`memory_summary.md`, `memory_index.md` — both replaced by
 * `memory_map.md`) follow the same boundary rule: their pinned copies stay
 * byte-frozen mid-epoch and are removed/replaced by the memory-map copy only
 * at a compaction/rebuild boundary.
 *
 * This module is intentionally dependency-light (fs/path/redaction/dream
 * constants only) so both `thread-runtime.ts` and `runner/shared.ts` can use
 * it without the runner→agent-manager→session→thread-runtime module cycle.
 */

import fs from "node:fs";
import path from "node:path";
import { redactMemoryText } from "./redaction.js";
import {
  MEMORY_MAP_MAX_CHARS,
  stripInjectedHtmlComments,
} from "./dream-storage.js";
import { USER_PROFILE_INJECTED_MAX_CHARS } from "./user-profile-store.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { createRuntimeLogger } from "../debug.js";

export { stripInjectedHtmlComments };

const logger = createRuntimeLogger("memory.resident-docs");

export const LIFE_REGISTRY_DISPLAY_PATH = "~/.stella/registry.md";
export const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const LIFE_MEMORY_MAP_DISPLAY_PATH = "~/.stella/memories/memory_map.md";
export const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";

/**
 * Display paths of docs that used to be injected but are retired now that
 * `memory_map.md` is the routing layer. Existing pinned copies under these
 * labels are retired at the next compaction/rebuild boundary; mid-epoch they
 * stay byte-frozen and suppress injection of the map (their content is still
 * resident, so injecting the map too would duplicate it inside one epoch).
 */
export const RETIRED_STARTUP_DOC_DISPLAY_PATHS: ReadonlySet<string> = new Set([
  "~/.stella/memories/memory_summary.md",
  "~/.stella/memories/memory_index.md",
]);

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
 * Dream's routing map — what memory contains and where to find it — read
 * synchronously for resident injection under its own path label. The single
 * resident Dream doc: it replaced both the focus summary and the routing
 * index. The cap here is a read-side backstop; the write-side jail rejects
 * over-cap writes outright so a capped read should never trigger in practice.
 */
export const readMemoryMapDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "memory_map.md"),
    MEMORY_MAP_MAX_CHARS,
  );

/**
 * The durable user-profile facts written by the `Remember` tool, read
 * synchronously for resident injection. The cap is a read-side backstop
 * mirroring the map's: the Remember write path mechanically rejects over-cap
 * bodies, so a capped read only fires on files no writer produced.
 */
export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "profile.md"),
    USER_PROFILE_INJECTED_MAX_CHARS,
  );

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
 * Retired display paths intentionally return undefined: there is no fresh
 * body for them, only the retirement transition in
 * {@link refreshResidentStartupDocs}.
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
    case LIFE_MEMORY_MAP_DISPLAY_PATH: {
      const memoryMap = readMemoryMapDoc(stellaDataDir);
      return memoryMap ? redactMemoryText(memoryMap.trim()) : undefined;
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

type StartupDocEntry = {
  entryId: string;
  displayPath: string;
  persistedDoc: string;
};

export type ResidentStartupDocRefreshResult = {
  /** Pinned copies rewritten in place from disk (includes the map conversion). */
  refreshedDocs: number;
  /** Retired or duplicate pinned copies deleted at the boundary. */
  removedDocs: number;
};

/**
 * Compaction/rebuild-boundary refresh of the pinned resident-doc copies.
 *
 * Called from `maybeCompactRuntimeThread` immediately after a compaction
 * overlay is written — the one moment the prompt prefix is being rebuilt and
 * the provider cache is already invalidated, so updating persisted head
 * entries costs nothing extra. Three responsibilities, all boundary-only:
 *
 *  1. Refresh: every surviving `bootstrap.startup_doc` entry whose source
 *     file changed is rewritten in place from disk (same entry id, same
 *     position — the pin holds). A missing/empty source for a live doc keeps
 *     the existing copy rather than blanking context.
 *  2. Dedupe: if the same doc path somehow has multiple visible copies (a
 *     legacy accumulation, or a mid-epoch first injection that predates a
 *     boundary conversion), the head-most copy is kept and later copies are
 *     deleted.
 *  3. Retire: pinned copies of retired docs (memory_summary / memory_index)
 *     are replaced by the memory-map copy. The head-most retired entry is
 *     converted in place into the map doc — so the map inherits the retired
 *     doc's protected head position — and every other retired copy is
 *     deleted. If a map copy already exists, retired copies are simply
 *     deleted. If no map body can be read from disk and no map copy exists,
 *     the retired copies are kept untouched (never blank resident context);
 *     the transition retries at the next boundary.
 *
 * MUST NOT be called outside a compaction/rebuild boundary: mid-epoch it
 * would mutate the prompt prefix and break cache stability.
 */
export const refreshResidentStartupDocs = (args: {
  store: RuntimeStore;
  threadKey: string;
  stellaDataDir: string;
}): ResidentStartupDocRefreshResult => {
  const messages = args.store.loadThreadMessages(args.threadKey);
  const entries: StartupDocEntry[] = [];
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
    entries.push({ entryId: message.entryId, displayPath, persistedDoc });
  }

  const result: ResidentStartupDocRefreshResult = {
    refreshedDocs: 0,
    removedDocs: 0,
  };
  const writeEntry = (entry: StartupDocEntry, freshDoc: string): void => {
    if (freshDoc.trim() === entry.persistedDoc.trim()) {
      return;
    }
    const updated = args.store.updateThreadCustomMessageContent({
      threadKey: args.threadKey,
      entryId: entry.entryId,
      content: [{ type: "text", text: freshDoc }],
    });
    if (updated) {
      result.refreshedDocs += 1;
    }
  };
  const removeEntry = (entry: StartupDocEntry): void => {
    const removed = args.store.removeThreadCustomMessage({
      threadKey: args.threadKey,
      entryId: entry.entryId,
    });
    if (removed) {
      result.removedDocs += 1;
    }
  };

  const retiredEntries = entries.filter((entry) =>
    RETIRED_STARTUP_DOC_DISPLAY_PATHS.has(entry.displayPath),
  );
  const hasExistingMapEntry = entries.some(
    (entry) => entry.displayPath === LIFE_MEMORY_MAP_DISPLAY_PATH,
  );
  const mapBody = readStartupDocBodyFromDisk(
    args.stellaDataDir,
    LIFE_MEMORY_MAP_DISPLAY_PATH,
  );
  // Retirement transition: the head-most retired entry becomes the map copy,
  // inheriting the retired doc's pinned head position. Only when no map copy
  // exists yet — converting alongside an existing copy would duplicate it.
  const convertedEntry =
    retiredEntries.length > 0 && mapBody && !hasExistingMapEntry
      ? retiredEntries[0]
      : undefined;

  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (entry === convertedEntry) {
      writeEntry(
        entry,
        buildStartupDocMessage(LIFE_MEMORY_MAP_DISPLAY_PATH, mapBody!),
      );
      seenPaths.add(LIFE_MEMORY_MAP_DISPLAY_PATH);
      continue;
    }
    if (RETIRED_STARTUP_DOC_DISPLAY_PATHS.has(entry.displayPath)) {
      // Removable once a live map copy is guaranteed to remain (converted
      // above or already persisted in this thread). Without one, keep the
      // frozen copy — its content is the only resident routing context this
      // thread still has; the transition retries at the next boundary.
      if (
        hasExistingMapEntry ||
        seenPaths.has(LIFE_MEMORY_MAP_DISPLAY_PATH)
      ) {
        removeEntry(entry);
      }
      continue;
    }
    if (seenPaths.has(entry.displayPath)) {
      removeEntry(entry);
      continue;
    }
    seenPaths.add(entry.displayPath);
    const freshBody = readStartupDocBodyFromDisk(
      args.stellaDataDir,
      entry.displayPath,
    );
    if (!freshBody) {
      continue;
    }
    writeEntry(entry, buildStartupDocMessage(entry.displayPath, freshBody));
  }

  // Boundary telemetry: one info record per epoch of what the refreshed
  // pinned prefix costs. Best-effort — telemetry must never fail a refresh.
  try {
    const postRefreshTexts: string[] = [];
    for (const message of args.store.loadThreadMessages(args.threadKey)) {
      const customMessage = message.customMessage;
      if (
        message.role === "runtimeInternal" &&
        customMessage?.customType === BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE
      ) {
        postRefreshTexts.push(customMessageText(customMessage.content));
      }
    }
    emitResidentStartupDocTelemetry({
      source: "compaction-boundary",
      stats: collectResidentStartupDocStats(postRefreshTexts),
    });
  } catch {
    // best-effort
  }
  return result;
};

/**
 * Telemetry over the resident startup docs riding a thread — the observable
 * for the two regression classes the memory redesign closed:
 *
 *  - copy accumulation (the pre-fix leak measured at ~13 stale copies /
 *    ~72K tokens per call): any doc path with more than one persisted copy;
 *  - cap pressure: an injected doc within 10% of its hard cap, the early
 *    signal before write-side rejections start refusing content.
 */
export type ResidentStartupDocStat = {
  displayPath: string;
  copies: number;
  /** Chars of the persisted copies (all copies summed) as injected. */
  injectedChars: number;
  /** Hard cap for capped docs (map, profile); absent for uncapped docs. */
  capChars?: number;
};

const RESIDENT_DOC_CAPS: Record<string, number> = {
  [LIFE_MEMORY_MAP_DISPLAY_PATH]: MEMORY_MAP_MAX_CHARS,
  [LIFE_USER_PROFILE_DISPLAY_PATH]: USER_PROFILE_INJECTED_MAX_CHARS,
};

const RESIDENT_DOC_CAP_PRESSURE_RATIO = 0.9;

/** Per-path copy counts and sizes from raw startup-doc message texts. */
export const collectResidentStartupDocStats = (
  docTexts: readonly string[],
): ResidentStartupDocStat[] => {
  const byPath = new Map<string, ResidentStartupDocStat>();
  for (const text of docTexts) {
    const displayPath = parseStartupDocPath(text);
    if (!displayPath) continue;
    const existing = byPath.get(displayPath);
    if (existing) {
      existing.copies += 1;
      existing.injectedChars += text.length;
      continue;
    }
    const capChars = RESIDENT_DOC_CAPS[displayPath];
    byPath.set(displayPath, {
      displayPath,
      copies: 1,
      injectedChars: text.length,
      ...(capChars ? { capChars } : {}),
    });
  }
  return [...byPath.values()];
};

export type ResidentDocTelemetryAnomalies = {
  /** Doc paths persisted more than once — the stale-copy leak signature. */
  duplicatePaths: string[];
  /** Capped docs at ≥90% of their cap. */
  capPressurePaths: string[];
};

/**
 * Change-keyed so a standing anomaly warns once when it appears (and again
 * only if it changes shape) instead of once per turn; the debug snapshot
 * still fires every emission for anyone tailing logs.
 */
let lastAnomalySignature = "";

/** Test seam: make anomaly warns deterministic across test cases. */
export const resetResidentDocTelemetryForTests = (): void => {
  lastAnomalySignature = "";
};

export const emitResidentStartupDocTelemetry = (args: {
  /** Where the observation was made: `prompt-build` or `compaction-boundary`. */
  source: string;
  stats: readonly ResidentStartupDocStat[];
}): ResidentDocTelemetryAnomalies => {
  const totalChars = args.stats.reduce(
    (sum, stat) => sum + stat.injectedChars,
    0,
  );
  const duplicatePaths = args.stats
    .filter((stat) => stat.copies > 1)
    .map((stat) => stat.displayPath);
  const capPressurePaths = args.stats
    .filter(
      (stat) =>
        stat.capChars !== undefined &&
        stat.copies === 1 &&
        stat.injectedChars >= stat.capChars * RESIDENT_DOC_CAP_PRESSURE_RATIO,
    )
    .map((stat) => stat.displayPath);

  const payload = {
    source: args.source,
    totalChars,
    docs: args.stats.map((stat) => ({
      path: stat.displayPath,
      copies: stat.copies,
      chars: stat.injectedChars,
      ...(stat.capChars !== undefined ? { cap: stat.capChars } : {}),
    })),
  };
  if (args.source === "compaction-boundary") {
    // Boundary frequency is cheap; an info-level record per epoch gives a
    // durable series of what each epoch's pinned prefix costs.
    logger.info("resident-docs.telemetry", payload);
  } else {
    logger.debug("resident-docs.telemetry", payload);
  }

  const signature = JSON.stringify({ duplicatePaths, capPressurePaths });
  const hasAnomaly = duplicatePaths.length > 0 || capPressurePaths.length > 0;
  if (hasAnomaly && signature !== lastAnomalySignature) {
    if (duplicatePaths.length > 0) {
      logger.warn("resident-docs.duplicate-copies", {
        source: args.source,
        paths: duplicatePaths,
        detail:
          "multiple persisted copies of a pinned resident doc — the stale-copy accumulation the single-pinned-copy fix eliminates; boundary refresh should dedupe these",
      });
    }
    if (capPressurePaths.length > 0) {
      logger.warn("resident-docs.cap-pressure", {
        source: args.source,
        paths: capPressurePaths,
        detail:
          "injected doc within 10% of its hard cap; writes will start being rejected when it fills",
      });
    }
  }
  if (hasAnomaly || lastAnomalySignature) {
    lastAnomalySignature = hasAnomaly ? signature : "";
  }
  return { duplicatePaths, capPressurePaths };
};
