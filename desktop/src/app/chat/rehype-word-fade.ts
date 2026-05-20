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
 * Why not use Streamdown's bundled `animated` plugin: it walks the
 * same HAST but rewrites every prior span's inline `--sd-duration` to
 * 0 ms based on a `prevContentLength` counter (instant snap to
 * visible). With Stella's word-cadence smooth-stream that collapses
 * the wave down to a single visible word at a time — the bug we hit
 * on the first attempt.
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

const wrapAsSpan = (text: string): Element => ({
  type: "element",
  tagName: "span",
  properties: { "data-stella-word-fade": true },
  children: [{ type: "text", value: text }],
});

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
 */
const groupTokens = (tokens: string[]): RootContent[] => {
  const out: RootContent[] = [];
  let buffer = "";
  let wordCount = 0;
  let pendingSeparator = "";

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(wrapAsSpan(buffer));
    buffer = "";
    wordCount = 0;
  };

  for (const tok of tokens) {
    if (isWhitespace(tok)) {
      if (wordCount === 0) {
        // Leading whitespace before any word in the current group —
        // belongs outside as a bare text node.
        out.push({ type: "text", value: tok });
      } else {
        // Defer until we see whether another word joins this group;
        // if not, the whitespace separates this group from the next.
        pendingSeparator += tok;
      }
      continue;
    }
    if (wordCount === 0) {
      buffer = tok;
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
        pendingSeparator = "";
      }
    }
  }
  flush();
  if (pendingSeparator.length > 0) {
    out.push({ type: "text", value: pendingSeparator });
  }
  return out;
};

export const rehypeWordFade = () => (tree: Root) => {
  visitParents(tree, "text", (node: Text, ancestors) => {
    for (const ancestor of ancestors) {
      if (ancestor.type === "element" && isSkippableAncestor(ancestor)) {
        return SKIP;
      }
    }
    const value = node.value;
    if (value.length === 0) return;
    if (isWhitespace(value)) return;

    const parent = ancestors[ancestors.length - 1];
    if (!parent || !("children" in parent)) return;
    const index = parent.children.indexOf(node);
    if (index === -1) return;

    const tokens = tokenize(value);
    if (tokens.length === 0) return;
    const replacements = groupTokens(tokens);
    if (replacements.length === 0) return;
    parent.children.splice(index, 1, ...replacements);
    return [SKIP, index + replacements.length];
  });
};
