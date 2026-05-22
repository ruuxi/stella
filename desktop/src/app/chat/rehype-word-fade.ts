/**
 * Streaming markdown reveal — rehype plugin.
 *
 * Walks each prose text node and groups every `WORDS_PER_GROUP` words
 * into one `<span data-stella-word-fade>`. The stylesheet's
 * `@keyframes` reveal fires when each span is first mounted into the
 * DOM. React reconciles the spans by tree position, so groups already
 * present in the prior render keep their identity (no re-animation)
 * while the freshly-appended trailing group(s) each play the fade
 * once. Multiple groups overlap mid-fade as the stream advances,
 * giving the soft "wave" reveal.
 *
 * Grouping (rather than one span per word) does two things:
 *   1. Reads as a phrase-level reveal instead of a per-token flicker,
 *      which is more comfortable at typical streaming speeds.
 *   2. Reduces the live span count by ~Nx, which keeps the trailing
 *      group's mid-stream content updates cheap in React.
 *
 * The trailing partial group is allowed to grow word-by-word in place
 * (its span identity stays put across renders, so the animation does
 * not restart). Only when the group reaches `WORDS_PER_GROUP` does it
 * "lock" and the next group spawns as a new sibling span — which is
 * the moment the next fade fires.
 *
 * Why this plugin instead of Streamdown's bundled `animated` plugin:
 * Streamdown emits one span per word; we group three words so the
 * reveal reads as a soft phrase wave rather than a per-token flicker.
 * Both plugins share the same `prevContentLength` cursor (below) so
 * structural remounts of already-rendered content stay flash-free.
 *
 * Why `prevContentLength`: Streamdown re-parses markdown on every
 * stream tick. When the markdown parser revises a token's shape (e.g.
 * `*foo` → `*foo*` becomes `<em><span>foo</span></em>`, or
 * `[label` → `[label](url)` becomes `<a><span>label</span></a>`), the
 * span moves to a new tree position. React's position-based key
 * reconciliation treats the relocated span as a new mount, so the CSS
 * fade-in keyframe replays from `opacity: 0` — that's the visible
 * "blink" mid-stream. Tracking each group's start position in the
 * source prose text and stamping `--stella-word-fade-duration: 0ms`
 * onto groups whose end position is within the previous render's
 * prose length means relocated spans still mount with the fade
 * animation, but the keyframe completes in 0ms — instant fully-
 * opaque, no flash.
 *
 * Skipped subtrees:
 *  - `<code>`, `<pre>`, `<math>`, `<style>`, `<script>`, `<svg>`,
 *    KaTeX output, Mermaid blocks — semantic whitespace or
 *    independently-rendered surfaces.
 *  - Streamdown's internal control surfaces (`[data-streamdown="…"]`)
 *    so copy buttons, table chrome, etc. don't fade in.
 */
import type { Element, Root, RootContent, Text } from "hast";
import { SKIP, visitParents } from "unist-util-visit-parents";

/**
 * Number of words bundled into one reveal span. 3 reads as a small
 * phrase at typical 12 ms-per-word streaming cadence — long enough
 * that the eye registers a single soft fade rather than a flurry of
 * per-word events, short enough that the trailing reveal still tracks
 * the cursor closely.
 */
const WORDS_PER_GROUP = 3;

const SKIP_TAGS = new Set([
  "code",
  "pre",
  "math",
  "style",
  "script",
  "noscript",
  "svg",
]);

const SKIP_CLASS_PREFIXES = ["katex", "language-mermaid"];

const isSkippableAncestor = (node: Element): boolean => {
  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;
  const props = (node.properties ?? {}) as Record<string, unknown>;
  if (props["dataStreamdown"] !== undefined) return true;
  const className = props.className;
  if (Array.isArray(className)) {
    for (const cls of className) {
      if (typeof cls !== "string") continue;
      for (const prefix of SKIP_CLASS_PREFIXES) {
        if (cls === prefix || cls.startsWith(`${prefix}-`)) return true;
      }
    }
  }
  return false;
};

/*
 * Tokenize "Hello, world! Stay" into alternating whitespace and
 * non-whitespace runs: ["Hello,", " ", "world!", " ", "Stay"].
 * Preserves the original character sequence exactly so
 * `tokens.join('') === input`.
 */
const tokenize = (value: string): string[] => {
  const tokens: string[] = [];
  const re = /\s+|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) tokens.push(match[0]);
  return tokens;
};

const isWhitespace = (value: string): boolean => /^\s+$/.test(value);

/**
 * `instant: true` stamps `--stella-word-fade-duration: 0ms` so the CSS
 * keyframe completes immediately — used for groups whose entire span
 * of source text was already rendered before this tick. Without the
 * override the fade replays from `opacity: 0` on any mid-stream
 * structural remount (e.g. `*foo` revising to `<em>foo</em>`).
 */
const wrapAsSpan = (text: string, instant: boolean): Element => ({
  type: "element",
  tagName: "span",
  properties: {
    "data-stella-word-fade": true,
    ...(instant ? { style: "--stella-word-fade-duration:0ms" } : {}),
  },
  children: [{ type: "text", value: text }],
});

/**
 * Per-cacheKey cumulative prose-character count from the prior render.
 * Module-scope so it survives Markdown component re-renders for the
 * same row (cacheKey is the stable per-row id passed in from
 * `useEventRows`). Cleared on demand from `resetWordFadeCursor` when a
 * row's Markdown instance unmounts.
 */
const prevContentLengthByCacheKey = new Map<string, number>();

/** Drop the prevContentLength cursor for a row that has unmounted. */
export const resetWordFadeCursor = (cacheKey: string): void => {
  prevContentLengthByCacheKey.delete(cacheKey);
};

/*
 * Bucket the flat token stream into reveal groups. Each group bundles
 * up to WORDS_PER_GROUP consecutive words *plus the whitespace between
 * them*, emitted as a single `<span data-stella-word-fade>`. The
 * whitespace that *separates* two groups stays outside any span (a
 * bare text node) so it always renders as normal collapsible flow
 * whitespace — which is what keeps word spacing intact across reveal
 * group boundaries.
 *
 * The trailing group may be partial (fewer than WORDS_PER_GROUP
 * words). On the next stream render the same trailing group is rebuilt
 * at the same sibling index; React reconciles it to the same DOM span,
 * so its content updates in place without restarting the animation.
 * Only when the group reaches WORDS_PER_GROUP words does the *next*
 * render start emitting a fresh sibling span after it — which is the
 * moment the next fade fires.
 *
 * `cursor` advances by emitted character so each group can stamp
 * itself as `instant` when its end position is `<= prevLength`.
 */
const groupTokens = (
  tokens: string[],
  cursor: { position: number },
  prevLength: number,
): RootContent[] => {
  const out: RootContent[] = [];
  let buffer = "";
  let bufferStart = cursor.position;
  let wordCount = 0;
  let pendingSeparator = "";

  const flush = () => {
    if (buffer.length === 0) return;
    const bufferEnd = bufferStart + buffer.length;
    const instant = prevLength > 0 && bufferEnd <= prevLength;
    out.push(wrapAsSpan(buffer, instant));
    cursor.position = bufferEnd;
    buffer = "";
    wordCount = 0;
  };

  for (const tok of tokens) {
    if (isWhitespace(tok)) {
      if (wordCount === 0) {
        // Leading whitespace before any word in the current group —
        // belongs outside as a bare text node.
        out.push({ type: "text", value: tok });
        cursor.position += tok.length;
        bufferStart = cursor.position;
      } else {
        // Defer until we see whether another word joins this group;
        // if not, the whitespace separates this group from the next.
        pendingSeparator += tok;
      }
      continue;
    }
    if (wordCount === 0) {
      buffer = tok;
      bufferStart = cursor.position;
      wordCount = 1;
    } else {
      buffer = buffer + pendingSeparator + tok;
      pendingSeparator = "";
      wordCount += 1;
    }
    if (wordCount >= WORDS_PER_GROUP) {
      flush();
      if (pendingSeparator.length > 0) {
        out.push({ type: "text", value: pendingSeparator });
        cursor.position += pendingSeparator.length;
        bufferStart = cursor.position;
        pendingSeparator = "";
      }
    }
  }
  flush();
  if (pendingSeparator.length > 0) {
    out.push({ type: "text", value: pendingSeparator });
    cursor.position += pendingSeparator.length;
  }
  return out;
};

export type RehypeWordFadeOptions = {
  /** Stable per-row id; gates the prevContentLength cursor map. */
  cacheKey: string;
};

export const rehypeWordFade =
  (options: RehypeWordFadeOptions) => (tree: Root) => {
    const prevLength = prevContentLengthByCacheKey.get(options.cacheKey) ?? 0;
    const cursor = { position: 0 };

    visitParents(tree, "text", (node: Text, ancestors) => {
      for (const ancestor of ancestors) {
        if (ancestor.type === "element" && isSkippableAncestor(ancestor)) {
          return SKIP;
        }
      }
      const value = node.value;
      if (value.length === 0) return;
      if (isWhitespace(value)) {
        cursor.position += value.length;
        return;
      }

      const parent = ancestors[ancestors.length - 1];
      if (!parent || !("children" in parent)) return;
      const index = parent.children.indexOf(node);
      if (index === -1) return;

      const tokens = tokenize(value);
      if (tokens.length === 0) return;
      const replacements = groupTokens(tokens, cursor, prevLength);
      if (replacements.length === 0) return;
      parent.children.splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });

    prevContentLengthByCacheKey.set(options.cacheKey, cursor.position);
  };
