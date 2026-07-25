/**
 * Minimal source-map consumer for renderer modules served by Vite in dev.
 *
 * Area-select resolves a clicked element back to the JSX that produced it.
 * The only machine-readable record of that position at runtime is
 * `fiber._debugStack`, whose frames carry *generated* coordinates — the line
 * and column inside the module Vite handed to the browser, not the line in
 * the `.tsx` on disk. Those two disagree badly: measured against
 * `ComposerContextChips.tsx`, the JSX sites drift by up to 119 lines (mean
 * -74), because the JSX/TS transform rewrites element trees into nested
 * `_jsxDEV(...)` calls and hoists imports. Reporting a generated line to the
 * agent would point it at the wrong function entirely, so the frame has to be
 * mapped back through the module's source map.
 *
 * Vite appends the map inline as a base64 `sourceMappingURL` comment, so the
 * bytes are already in the renderer's HTTP cache from loading the module in
 * the first place — no extra network round trip, just a decode. Decoding is
 * done lazily (only for modules a selection actually lands in) and memoized
 * per URL, which keeps the cost off the render path entirely: it is paid once
 * per module, on a user-initiated click.
 *
 * This is deliberately not a general-purpose source-map library. It reads only
 * `mappings`/`sources`/`sourceRoot`, ignores names, and answers exactly one
 * question — "which original line produced this generated position?".
 */

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_VALUES = /* @__PURE__ */ (() => {
  const table = new Map<string, number>();
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table.set(BASE64_ALPHABET[index]!, index);
  }
  return table;
})();

const INLINE_MAP_RE =
  /\/\/[#@]\s*sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/;

/** One decoded mapping segment; only the fields we need are retained. */
type Segment = {
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
};

type DecodedMap = {
  sources: string[];
  /** Segments per generated line, indexed 0-based, each sorted by column. */
  lines: Segment[][];
};

/**
 * Decodes a base64 VLQ field into signed integers. Source-map segments encode
 * each value as a run of 6-bit groups: bit 5 is the continuation flag, and in
 * the first group bit 0 is the sign, so the payload is shifted accordingly.
 */
const decodeVlq = (field: string): number[] => {
  const values: number[] = [];
  let result = 0;
  let shift = 0;

  for (let index = 0; index < field.length; index += 1) {
    const digit = BASE64_VALUES.get(field[index]!);
    if (digit === undefined) return values;

    const hasContinuation = (digit & 32) !== 0;
    result += (digit & 31) << shift;

    if (hasContinuation) {
      shift += 5;
      continue;
    }

    const negative = (result & 1) === 1;
    result >>= 1;
    values.push(negative ? -result : result);
    result = 0;
    shift = 0;
  }

  return values;
};

/**
 * Expands the `mappings` string into per-line segment lists. Segment fields
 * are stored as deltas that accumulate across the whole file (except the
 * generated column, which resets each line), so this has to run start to end.
 */
const decodeMappings = (mappings: string): Segment[][] => {
  const lines: Segment[][] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  for (const lineField of mappings.split(";")) {
    const segments: Segment[] = [];
    let generatedColumn = 0;

    if (lineField) {
      for (const segmentField of lineField.split(",")) {
        if (!segmentField) continue;
        const values = decodeVlq(segmentField);
        if (values.length === 0) continue;

        generatedColumn += values[0]!;
        // A 1-field segment marks generated output with no original
        // counterpart (injected imports, HMR preamble); skip it.
        if (values.length < 4) continue;

        sourceIndex += values[1]!;
        originalLine += values[2]!;
        originalColumn += values[3]!;
        segments.push({
          generatedColumn,
          sourceIndex,
          originalLine,
          originalColumn,
        });
      }
    }

    segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
    lines.push(segments);
  }

  return lines;
};

const decodeBase64 = (value: string): string | null => {
  try {
    // The map is UTF-8; `atob` yields latin1, so round-trip through
    // TextDecoder to keep non-ASCII paths and content intact.
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const parseInlineMap = (
  moduleText: string,
  moduleUrl: string,
): DecodedMap | null => {
  const match = moduleText.match(INLINE_MAP_RE);
  if (!match?.[1]) return null;

  const json = decodeBase64(match[1]);
  if (!json) return null;

  try {
    const raw = JSON.parse(json) as {
      mappings?: unknown;
      sources?: unknown;
      sourceRoot?: unknown;
    };
    if (typeof raw.mappings !== "string" || !Array.isArray(raw.sources)) {
      return null;
    }

    const sourceRoot =
      typeof raw.sourceRoot === "string" ? raw.sourceRoot : "";
    // Vite emits bare file names here (`sources: ["Composer.tsx"]`), which are
    // relative to the module's own URL per the source-map spec. Resolving them
    // is what turns a basename back into a path the agent can open.
    const sources = raw.sources.map((source) => {
      if (typeof source !== "string") return "";
      const joined = `${sourceRoot}${source}`;
      try {
        return new URL(joined, moduleUrl).href;
      } catch {
        return joined;
      }
    });

    return { sources, lines: decodeMappings(raw.mappings) };
  } catch {
    return null;
  }
};

/**
 * Per-URL memo. `null` records a module we already failed to map so repeated
 * selections in the same file don't re-fetch it.
 */
const mapCache = new Map<string, Promise<DecodedMap | null>>();

const loadMap = (moduleUrl: string): Promise<DecodedMap | null> => {
  const cached = mapCache.get(moduleUrl);
  if (cached) return cached;

  const pending = fetch(moduleUrl)
    .then((response) => (response.ok ? response.text() : null))
    .then((text) => (text ? parseInlineMap(text, moduleUrl) : null))
    .catch(() => null);

  mapCache.set(moduleUrl, pending);
  return pending;
};

export type OriginalPosition = {
  source: string;
  line: number;
  column: number;
};

/**
 * Maps a 1-based generated position in `moduleUrl` back to its original
 * position, or null when the module has no usable inline map.
 *
 * Picks the last segment at or before the requested column — the standard
 * source-map lookup rule, since a segment stays in effect until the next one
 * starts. Falls back to the first segment on the line when the column lands
 * before any of them (which happens when a frame points at a wrapper the
 * transform inserted ahead of the mapped expression).
 */
export const originalPositionFor = async (
  moduleUrl: string,
  generatedLine: number,
  generatedColumn: number,
): Promise<OriginalPosition | null> => {
  const map = await loadMap(moduleUrl);
  if (!map) return null;

  const segments = map.lines[generatedLine - 1];
  if (!segments || segments.length === 0) return null;

  const targetColumn = generatedColumn - 1;
  let match: Segment | null = null;
  for (const segment of segments) {
    if (segment.generatedColumn > targetColumn) break;
    match = segment;
  }
  match ??= segments[0]!;

  const source = map.sources[match.sourceIndex];
  if (!source) return null;

  return {
    source,
    line: match.originalLine + 1,
    column: match.originalColumn + 1,
  };
};

/** Test seam: drops memoized maps so a suite can assert fetch behaviour. */
export const resetInlineSourceMapCache = (): void => {
  mapCache.clear();
};
