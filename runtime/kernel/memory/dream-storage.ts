/**
 * On-disk markdown layout the Dream agent edits.
 *
 * The Dream agent never CREATES these files — `ensureDreamMemoryLayout` seeds
 * them with stable templates the first time the scheduler runs (or on
 * startup). The agent then surgically edits them via StrReplace using the
 * unique anchor markers below.
 *
 * Layout after the memory_map migration:
 *   - `MEMORY.md`      — durable task-group ledger (unchanged).
 *   - `memory_map.md`  — the single resident routing doc. Replaces both
 *     `memory_summary.md` (narrative retired — the compaction checkpoint owns
 *     recent narrative now that it is validity-gated) and `memory_index.md`
 *     (merged in). Pointer-only, hard-capped; over-cap writes are rejected at
 *     the tool boundary so Dream must curate rather than truncate.
 *   - `memory_summary.md` / `memory_index.md` — retired. Existing files are
 *     preserved on disk (marked with a retirement banner) but are no longer
 *     seeded, read, injected, or writable by Dream. Their routing content is
 *     folded into the first `memory_map.md` seed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_MAP_FILE = "memory_map.md";
/** Retired file names, kept for migration and jail error messages. */
export const MEMORY_SUMMARY_FILE = "memory_summary.md";
export const MEMORY_INDEX_FILE = "memory_index.md";

/**
 * Hard budget for `memory_map.md`, measured on the INJECTED view (HTML
 * comments stripped — anchors and charter guidance are free; routed content
 * is not). Enforced mechanically at the StrReplace boundary: writes that
 * would exceed it are rejected with an error, never silently truncated.
 */
export const MEMORY_MAP_MAX_CHARS = 6_000;
export const MEMORY_MAP_MAX_ENTRIES = 80;
export const MEMORY_MAP_STALE_DAYS = 90;

export const MEMORY_MAP_ROUTES_START_ANCHOR = "<!-- DREAM:MAP_START -->";
export const MEMORY_MAP_ROUTES_END_ANCHOR = "<!-- DREAM:MAP_END -->";
export const MEMORY_MAP_DERIVED_START_ANCHOR = "<!-- DREAM:DERIVED_START -->";
export const MEMORY_MAP_DERIVED_END_ANCHOR = "<!-- DREAM:DERIVED_END -->";
const MEMORY_MAP_MIGRATED_START_ANCHOR = "<!-- DREAM:MIGRATED_SUMMARY_START -->";
const MEMORY_MAP_MIGRATED_END_ANCHOR = "<!-- DREAM:MIGRATED_SUMMARY_END -->";

const MEMORY_MAP_ROUTES_PLACEHOLDER = "- No routing entries recorded yet.";
const MEMORY_MAP_DERIVED_PLACEHOLDER = "- None pending promotion.";

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

/**
 * The charter travels as an HTML comment so Dream sees it when reading the
 * file while the injected view (comments stripped) spends the whole budget on
 * routing content.
 */
const MEMORY_MAP_CHARTER = `<!-- DREAM:MAP_CHARTER
Memory map — the single resident routing layer, maintained by Dream. It
replaces memory_summary.md and memory_index.md. Pointer-only: what memory
contains and where to find it. No narrative, no restated facts — the durable
facts live in MEMORY.md blocks; this file only routes to them.

Routing entries (between the DREAM:MAP anchors), one line each:
- <task family / topic> -> <best source> (updated YYYY-MM-DD) | aliases: <words the user actually says>
  Best source is one of: MEMORY.md <block date — title>, profile.md,
  threads:<thread_id>, or transcripts.

## Derived constraints (between the DREAM:DERIVED anchors) stages durable
constraints observed in conversation that have not yet been promoted to
profile.md via the Remember tool. One line each, tagged [derived YYYY-MM-DD].
Remove a line once it is promoted. Never edit profile.md yourself.

Hard budget: ${MEMORY_MAP_MAX_CHARS} injected characters (HTML comments are
not counted) and about ${MEMORY_MAP_MAX_ENTRIES} entries. Writes that would
exceed the budget are REJECTED with an error — curate (merge, prune, tighten)
instead of truncating. Prune entries older than ${MEMORY_MAP_STALE_DAYS} days
unless recent usage shows they are still useful. Never store secrets,
credentials, tokens, private keys, auth headers, or sensitive personal data.
Edit only with StrReplace using small unique anchors; keep every DREAM anchor
comment intact.
-->`;

const buildMemoryMapContent = (args: {
  routes: string;
  migratedSummary?: string;
}): string => {
  const sections = [
    MEMORY_MAP_CHARTER,
    "# Memory map",
    "",
    MEMORY_MAP_ROUTES_START_ANCHOR,
    args.routes,
    MEMORY_MAP_ROUTES_END_ANCHOR,
    "",
    "## Derived constraints",
    "",
    MEMORY_MAP_DERIVED_START_ANCHOR,
    MEMORY_MAP_DERIVED_PLACEHOLDER,
    MEMORY_MAP_DERIVED_END_ANCHOR,
  ];
  if (args.migratedSummary) {
    sections.push(
      "",
      "## Migrated focus notes (from memory_summary.md)",
      "",
      "<!-- One-time migration staging: rewrite each line below as a routing entry",
      "or drop it (the facts are already in MEMORY.md), then delete this whole",
      "section including its anchors. -->",
      MEMORY_MAP_MIGRATED_START_ANCHOR,
      args.migratedSummary,
      MEMORY_MAP_MIGRATED_END_ANCHOR,
    );
  }
  return `${sections.join("\n")}\n`;
};

const MEMORY_MAP_TEMPLATE = buildMemoryMapContent({
  routes: MEMORY_MAP_ROUTES_PLACEHOLDER,
});

export const memoriesRoot = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "memories");

export const memoryFilePath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_FILE);

export const memoryMapPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_MAP_FILE);

/** Retired paths — used only by the migration seed and jail diagnostics. */
export const memorySummaryPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_SUMMARY_FILE);

export const memoryIndexPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_INDEX_FILE);

const writeIfMissing = async (
  target: string,
  contents: string,
): Promise<boolean> => {
  try {
    await fs.access(target);
    return false;
  } catch {
    await fs.writeFile(target, contents, "utf-8");
    return true;
  }
};

const readOptionalFile = async (target: string): Promise<string | null> => {
  try {
    return await fs.readFile(target, "utf-8");
  } catch {
    return null;
  }
};

/**
 * Strip HTML comment blocks from a memory doc before it is measured or
 * injected into model context. Dream's conventions keep archives, charters,
 * and anchors inside comments; only non-comment content costs injection
 * budget. An unterminated `<!--` is stripped through end-of-doc so a
 * malformed comment can't leak an archive back into context. Canonical
 * implementation for the whole memory layer (re-exported by
 * `resident-docs.ts`, whose callers own the injection path).
 */
export const stripInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--[\s\S]*$/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

/**
 * Line-preserving variant of {@link stripInjectedHtmlComments} for
 * line-oriented readers (Recall's memory line search): comment characters are
 * blanked but every newline is kept, so reported line numbers still match the
 * on-disk file while comment text — the map charter, anchors, retired blocks
 * — can no longer produce matches. Unterminated `<!--` blanks through
 * end-of-doc, same as the stripping variant.
 */
export const blankInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ""))
    .replace(/<!--[\s\S]*$/u, (comment) => comment.replace(/[^\n]/gu, ""));

const stripComments = stripInjectedHtmlComments;

/**
 * Extract the content between a retired doc's anchor comments; falls back to
 * the comment-stripped body when the anchors were edited away.
 */
const extractAnchoredBody = (
  raw: string,
  startAnchor: string,
  endAnchor: string,
): string => {
  const start = raw.indexOf(startAnchor);
  const end = raw.indexOf(endAnchor);
  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start + startAnchor.length, end).trim();
  }
  return stripComments(raw);
};

const dropPlaceholder = (body: string, placeholder: string): string =>
  body === placeholder ? "" : body;

/** Truncate at a line boundary so a folded entry is never cut mid-line. */
const truncateAtLineBoundary = (
  text: string,
  maxChars: number,
  marker: string,
): string => {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, Math.max(0, maxChars));
  const lastNewline = slice.lastIndexOf("\n");
  return `${lastNewline > 0 ? slice.slice(0, lastNewline) : slice}\n${marker}`;
};

const RETIREMENT_BANNER_PREFIX = "<!-- RETIRED";

const buildRetirementBanner = (fileName: string): string =>
  `${RETIREMENT_BANNER_PREFIX} ${new Date().toISOString().slice(0, 10)}: ${fileName} was replaced by ${MEMORY_MAP_FILE}. Stella no longer reads, injects, or writes this file; it is preserved for reference. -->\n`;

/**
 * One-time migration seed for `memory_map.md`, built from whatever the
 * retired docs contain so no routing signal is lost at the cutover:
 * `memory_index.md` entries become the initial routing entries verbatim;
 * `memory_summary.md`'s active bullets land in a clearly-marked staging
 * section for Dream to curate into routes (or drop — every summary fact is
 * provably duplicated in MEMORY.md). Folded content is bounded so the seeded
 * map's injected view respects the hard cap; anything cut by the bound
 * remains readable in the retired files, which are never deleted.
 */
const buildSeededMemoryMapContent = (args: {
  indexRaw: string | null;
  summaryRaw: string | null;
}): string => {
  const indexBody = args.indexRaw
    ? dropPlaceholder(
        extractAnchoredBody(
          args.indexRaw,
          "<!-- DREAM:INDEX_START -->",
          "<!-- DREAM:INDEX_END -->",
        ),
        MEMORY_MAP_ROUTES_PLACEHOLDER,
      )
    : "";
  const summaryBody = args.summaryRaw
    ? dropPlaceholder(
        extractAnchoredBody(
          args.summaryRaw,
          "<!-- DREAM:SUMMARY_START -->",
          "<!-- DREAM:SUMMARY_END -->",
        ),
        "- No active focus recorded yet.",
      )
    : "";
  if (!indexBody && !summaryBody) {
    return MEMORY_MAP_TEMPLATE;
  }
  // Budget the folded content against the injected cap, favoring the index
  // (already routing-shaped) over the summary staging notes. The initial
  // budgets are estimates (the flat allowance cannot account for the
  // migrated-section heading or the line-boundary cut markers, which land
  // OUTSIDE the budgets), so the result is proved under the cap by
  // measurement: each pass measures the actual injected length and shrinks
  // the offending budget by the exact overage. Fixed-size markers plus a
  // strictly shrinking budget make each pass monotonically tighter; the
  // bare template (always under the cap) is the terminal fallback, so the
  // seeded map's injected view respects the hard cap by construction.
  const templateOverheadChars = stripComments(MEMORY_MAP_TEMPLATE).length + 80;
  const initialRoutesBudget = Math.floor(
    (MEMORY_MAP_MAX_CHARS - templateOverheadChars) * 0.6,
  );
  const ROUTES_CUT_MARKER = `[migration cut — remaining entries preserved in ${MEMORY_INDEX_FILE}]`;
  const SUMMARY_CUT_MARKER = `[migration cut — full text preserved in ${MEMORY_SUMMARY_FILE}]`;
  const MAX_FIT_PASSES = 6;

  let summaryShrink = 0;
  let routesShrink = 0;
  for (let pass = 0; pass < MAX_FIT_PASSES; pass += 1) {
    const routesBudget = Math.max(0, initialRoutesBudget - routesShrink);
    const routes =
      indexBody && routesBudget > 0
        ? truncateAtLineBoundary(indexBody, routesBudget, ROUTES_CUT_MARKER)
        : MEMORY_MAP_ROUTES_PLACEHOLDER;
    const summaryBudget =
      MEMORY_MAP_MAX_CHARS -
      templateOverheadChars -
      (indexBody ? stripComments(routes).length : 0) -
      summaryShrink;
    const migratedSummary =
      summaryBody && summaryBudget > 0
        ? truncateAtLineBoundary(summaryBody, summaryBudget, SUMMARY_CUT_MARKER)
        : undefined;
    const candidate = buildMemoryMapContent({
      routes,
      ...(migratedSummary ? { migratedSummary } : {}),
    });
    const overage = stripComments(candidate).length - MEMORY_MAP_MAX_CHARS;
    if (overage <= 0) {
      return candidate;
    }
    // Shrink the staging section first (it is disposable — every summary
    // fact is provably duplicated in MEMORY.md / the retired file); only
    // once it is gone does the routing content give ground.
    if (migratedSummary) {
      summaryShrink += overage;
    } else {
      routesShrink += overage;
    }
  }
  return MEMORY_MAP_TEMPLATE;
};

/** Prepend the retirement banner unless the file already carries one. */
const markRetiredFile = async (
  target: string,
  fileName: string,
): Promise<void> => {
  const raw = await readOptionalFile(target);
  if (raw === null || raw.startsWith(RETIREMENT_BANNER_PREFIX)) {
    return;
  }
  await fs.writeFile(target, `${buildRetirementBanner(fileName)}${raw}`, "utf-8");
};

export const ensureDreamMemoryLayout = async (
  stellaDataDir: string,
): Promise<void> => {
  const root = memoriesRoot(stellaDataDir);
  await fs.mkdir(root, { recursive: true });
  await writeIfMissing(memoryFilePath(stellaDataDir), MEMORY_TEMPLATE);
  const mapTarget = memoryMapPath(stellaDataDir);
  try {
    await fs.access(mapTarget);
    return;
  } catch {
    // First run after the migration (or a fresh install): seed the map from
    // the retired docs, then mark them retired. Retired files are preserved
    // byte-for-byte below the banner — never deleted.
  }
  const [indexRaw, summaryRaw] = await Promise.all([
    readOptionalFile(memoryIndexPath(stellaDataDir)),
    readOptionalFile(memorySummaryPath(stellaDataDir)),
  ]);
  const seeded = await writeIfMissing(
    mapTarget,
    buildSeededMemoryMapContent({ indexRaw, summaryRaw }),
  );
  if (seeded) {
    await markRetiredFile(
      memorySummaryPath(stellaDataDir),
      MEMORY_SUMMARY_FILE,
    );
    await markRetiredFile(memoryIndexPath(stellaDataDir), MEMORY_INDEX_FILE);
  }
};

export const readMemoryFile = async (
  stellaDataDir: string,
): Promise<string | null> => await readOptionalFile(memoryFilePath(stellaDataDir));

export const readMemoryMap = async (
  stellaDataDir: string,
): Promise<string | null> => await readOptionalFile(memoryMapPath(stellaDataDir));
