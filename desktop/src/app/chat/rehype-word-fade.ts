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
 * Three-way decision for each emitted span:
 *
 *   1. SAME span as the prior render (matching `(bufferStart, parent
 *      path)` signature): emit with no inline style. Its in-flight
 *      animation (if any) keeps running untouched. THIS IS THE
 *      LOAD-BEARING CASE — any inline style change to an existing
 *      span causes Chromium to recompute `animation-duration`
 *      retroactively, which truncates the live fade and reads as
 *      "no animation".
 *
 *   2. New span carrying content that was visible in the prior render
 *      (structural remount — `*foo` → `<em>foo</em>` moves the span
 *      to a new tree position and React mounts a fresh DOM element):
 *      stamp `--stella-word-fade-duration:0ms`. Fresh mount, so the
 *      CSS keyframe is freshly evaluated with the var at 0ms and
 *      completes instantly. The previously-visible text stays silently
 *      on screen during the structural shuffle. No truncation
 *      concern — the span never had a 600ms animation to begin with.
 *
 *   3. New span carrying genuinely new content (the streaming tail
 *      just produced a new word group): emit with no inline style and
 *      let the default 600ms fade-in play.
 *
 * Substring check (case 2) uses the prior render's concatenated prose
 * text. It's O(n·m) per span; for typical streaming message lengths
 * (a few KB) it's still cheap. The reshape signal is "the span's
 * tree position is new but its text was already on screen".
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
 * keyframe completes immediately — only used for FRESHLY MOUNTED
 * spans carrying previously-visible content. NEVER applied to a span
 * that already exists from the prior render; mid-flight inline-style
 * changes truncate the live animation.
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
 * Per-cacheKey snapshot from the prior plugin run. `emittedKeys` is
 * the set of `(bufferStart|parentPath)` signatures we emitted last
 * time; matches here are the "same span continuing" case (case 1)
 * and MUST NOT receive an inline-style stamp. `priorProse` is the
 * concatenated prose text of the prior render; substring matches are
 * the "fresh mount of previously-visible content" case (case 2).
 */
type PerCacheState = {
  emittedKeys: Set<string>;
  priorProse: string;
};

const stateByCacheKey = new Map<string, PerCacheState>();

const emptyState: PerCacheState = {
  emittedKeys: new Set(),
  priorProse: "",
};

/** Drop the per-row cursor when this Markdown row unmounts. */
export const resetWordFadeCursor = (cacheKey: string): void => {
  stateByCacheKey.delete(cacheKey);
};

/*
 * Build a `parentPath` string from the visitor's ancestor chain. Each
 * element segment is `${childIndex}:${tagName}` — childIndex makes
 * sibling paragraphs distinguishable (otherwise two `<p>` siblings
 * would share `p` and look "the same"). The root is omitted.
 */
const buildParentPath = (
  ancestors: ReadonlyArray<Root | Element>,
): string => {
  const parts: string[] = [];
  for (let i = 1; i < ancestors.length; i++) {
    const parent = ancestors[i - 1];
    const child = ancestors[i];
    if (parent.type !== "root" && parent.type !== "element") continue;
    if (child.type !== "element") continue;
    const index = (parent.children as RootContent[]).indexOf(child);
    parts.push(`${index}:${child.tagName}`);
  }
  return parts.join(">");
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
 * Per-group `instant` decision is delegated to the caller via
 * `decideInstant({ content, bufferStart })` so the same grouping pass
 * can ask the per-cacheKey signature/prose-substring tracker.
 */
const groupTokens = (
  tokens: string[],
  cursor: { position: number },
  decideInstant: (info: { content: string; bufferStart: number }) => boolean,
): RootContent[] => {
  const out: RootContent[] = [];
  let buffer = "";
  let bufferStart = cursor.position;
  let wordCount = 0;
  let pendingSeparator = "";

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer;
    const start = bufferStart;
    const instant = decideInstant({ content, bufferStart: start });
    out.push(wrapAsSpan(content, instant));
    cursor.position = start + content.length;
    buffer = "";
    wordCount = 0;
  };

  for (const tok of tokens) {
    if (isWhitespace(tok)) {
      if (wordCount === 0) {
        out.push({ type: "text", value: tok });
        cursor.position += tok.length;
        bufferStart = cursor.position;
      } else {
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
  /** Stable per-row id; gates the per-cacheKey signature/prose map. */
  cacheKey: string;
};

export const rehypeWordFade =
  (options: RehypeWordFadeOptions) => (tree: Root) => {
    const prior = stateByCacheKey.get(options.cacheKey) ?? emptyState;
    const nextEmittedKeys = new Set<string>();
    let proseAcc = "";
    const cursor = { position: 0 };

    visitParents(tree, "text", (node: Text, ancestors) => {
      for (const ancestor of ancestors) {
        if (ancestor.type === "element" && isSkippableAncestor(ancestor)) {
          return SKIP;
        }
      }
      const value = node.value;
      if (value.length === 0) return;
      proseAcc += value;
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

      const parentPath = buildParentPath(
        ancestors as ReadonlyArray<Root | Element>,
      );

      const decideInstant = (info: {
        content: string;
        bufferStart: number;
      }): boolean => {
        const key = `${info.bufferStart}|${parentPath}`;
        nextEmittedKeys.add(key);
        // Case 1: the same span survives from the prior render. Never
        // stamp an inline style — that would truncate the live fade.
        if (prior.emittedKeys.has(key)) return false;
        // Case 2: fresh mount, but the content was already on screen
        // (markdown reshape moved the span to a new tree position).
        // Stamp instant so the keyframe completes in 0ms and the user
        // doesn't see a structural-remount flash.
        if (prior.priorProse.length > 0 && prior.priorProse.includes(info.content)) {
          return true;
        }
        // Case 3: fresh mount, genuinely new content. Default 600ms
        // fade plays.
        return false;
      };

      const replacements = groupTokens(tokens, cursor, decideInstant);
      if (replacements.length === 0) return;
      parent.children.splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });

    stateByCacheKey.set(options.cacheKey, {
      emittedKeys: nextEmittedKeys,
      priorProse: proseAcc,
    });
  };
