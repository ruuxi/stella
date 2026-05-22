import type { CSSProperties, ImgHTMLAttributes } from "react";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";
import { cn } from "@/shared/lib/utils";
import { useActiveEmojiPack } from "./emoji-sprites/active-emoji-pack";
import { remarkEmojiSprites } from "./emoji-sprites/remark-emoji-sprites";
import { rehypeWordFade, resetWordFadeCursor } from "./rehype-word-fade";
import {
  cellToRowCol,
  getEmojiSpriteGridSize,
  parseEmojiSpriteUrl,
} from "./emoji-sprites/sprite-map";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
  isAnimating?: boolean;
  /** Suppress GFM horizontal rules (`---`). Used in chat bubbles where
   *  models often append a trailing rule that reads as a message divider. */
  hideHorizontalRules?: boolean;
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  node?: unknown;
};

/*
 * Streamdown's `remarkPlugins` prop *replaces* its defaults (which
 * include `remark-gfm` for tables/strikethrough/task lists), so we
 * have to spread its defaults back in alongside our additions.
 * `defaultRemarkPlugins` is exported as a `Record<string, Pluggable>`
 * map; the prop wants an array, so unwrap with `Object.values`.
 *
 * `REMARK_PLUGINS` is the single stable array shape we ever hand
 * Streamdown — including `remarkEmojiSprites` unconditionally. Emoji
 * lookup is bundled locally in the desktop app, while the selected pack's
 * sheet URLs live in localStorage; chat rendering must not depend on a
 * Convex query after the pack is installed.
 */
const DEFAULT_REMARK_PLUGINS = Object.values(defaultRemarkPlugins);
const REMARK_PLUGINS = [...DEFAULT_REMARK_PLUGINS, remarkEmojiSprites];

/*
 * Streamdown's `rehypePlugins` prop, like `remarkPlugins`, *replaces*
 * its defaults — re-spread them so harden / sanitize / raw stay in
 * place. The word-fade plugin appends after them so it observes the
 * post-sanitize HAST (and inherits the same allow-list).
 */
const DEFAULT_REHYPE_PLUGINS = Object.values(defaultRehypePlugins);

/*
 * Streamdown internally defers streaming block updates with React
 * `startTransition` only when its `animated` prop is absent. After an
 * upstream token pause that deferred parse can catch up in one visible
 * commit (the debug logs show `p` -> `p>p>p` with a large text-length
 * jump), which reads as the remaining single flicker.
 *
 * We still do NOT want Streamdown's own animate rehype plugin because
 * it snaps prior words to `duration: 0ms`. Passing a truthy `animated`
 * prop but forcing Streamdown's `isAnimating` context false gives us the
 * synchronous block-update path without registering its animation plugin.
 * Our own `rehypeWordFade` remains gated by `pluginActive` below.
 */
const STREAMDOWN_SYNC_RENDER = { duration: 0, stagger: 0 } as const;

/*
 * Disable Streamdown's built-in "Open external link?" confirmation modal.
 *
 * We don't need it because the Electron main process already gates every
 * external open through `ExternalLinkService.setupExternalLinkHandlers`
 * (`setWindowOpenHandler` + `will-navigate` → `shell.openExternal`), so
 * a chat link click is already routed safely to the OS browser without
 * any in-renderer confirmation.
 *
 * Leaving it enabled caused three regressions in the chat surface:
 *   1. Streamdown rendered each link as a `<button>` and called
 *      `preventDefault()`, which made the surrounding message bubble pick
 *      up button focus / active styling on click ("the message gets
 *      highlighted").
 *   2. Streamdown's modal uses `position: fixed`, but our chat list is
 *      virtualized by `@legendapp/list` which applies `transform` to row
 *      containers — a transformed ancestor traps `position: fixed`, so
 *      the modal would render centered on the clicked *message* instead
 *      of the viewport.
 *   3. The modal carried Streamdown's own card chrome, not the
 *      Connect-dialog aesthetic the rest of the app uses.
 *
 * With `enabled: false`, links render as plain `<a target="_blank">` and
 * Electron's main-process handlers take over.
 */
const LINK_SAFETY = { enabled: false } as const;

const areMarkdownPropsEqual = (
  prev: MarkdownProps,
  next: MarkdownProps,
): boolean =>
  prev.text === next.text &&
  prev.cacheKey === next.cacheKey &&
  prev.className === next.className &&
  Boolean(prev.isAnimating) === Boolean(next.isAnimating) &&
  Boolean(prev.hideHorizontalRules) === Boolean(next.hideHorizontalRules);

const MarkdownImage = ({
  src,
  alt,
  className,
  ...rest
}: MarkdownImageProps) => {
  const cell = typeof src === "string" ? parseEmojiSpriteUrl(src) : null;
  if (!cell) {
    return <img {...rest} src={src} alt={alt} className={className} />;
  }
  const { row, col } = cellToRowCol(cell.cell);
  const gridSize = getEmojiSpriteGridSize();
  const last = Math.max(1, gridSize - 1);
  return (
    <span
      className={cn("ai-emoji", className)}
      style={
        {
          "--ai-emoji-row": String(row),
          "--ai-emoji-col": String(col),
          backgroundImage: `var(--ai-emoji-sheet-${cell.sheet}-url)`,
          backgroundSize: `${gridSize * 100}% ${gridSize * 100}%`,
          backgroundPosition: `${(col / last) * 100}% ${(row / last) * 100}%`,
        } as CSSProperties
      }
      role="img"
      aria-label={alt ?? ""}
    />
  );
};

const buildComponents = (hideHorizontalRules: boolean) => ({
  ...(hideHorizontalRules ? { hr: () => null } : {}),
  img: MarkdownImage,
});

let nextAnonCacheKey = 0;

export const Markdown = memo(function Markdown({
  text,
  cacheKey,
  className,
  isAnimating = false,
  hideHorizontalRules = false,
}: MarkdownProps) {
  /*
   * Keep the word-fade HAST shape for the lifetime of a row once that
   * row has streamed. When the live row locks, `isAnimating` flips
   * false while React keeps the same row key; if we removed the plugin
   * immediately, Streamdown would rebuild the body from
   * `<span data-stella-word-fade>…</span>` wrappers back into raw text
   * nodes, which reads as a one-frame flicker near the start of some
   * streams. Freshly mounted historical rows start with
   * `isAnimating=false`, so they still render as plain markdown.
   *
   * When streaming finishes, Streamdown may still re-parse the final
   * body (incomplete-markdown settle, late layout, or eventual
   * persisted-row handoff). That remounts `[data-stella-word-fade]`
   * spans, but each
   * span's inline `--stella-word-fade-duration: 0ms` (stamped by the
   * plugin based on the previous render's prose length) collapses the
   * keyframe to 0ms — instant fully-opaque, no flash. `revealSettled`
   * still drops `animation: none` on top of that as a belt-and-
   * suspenders guard for any final-row settle.
   */
  const hasRenderedStreamingMarkupRef = useRef(false);
  if (isAnimating) {
    hasRenderedStreamingMarkupRef.current = true;
  }
  const pluginActive = hasRenderedStreamingMarkupRef.current;
  const revealSettled = pluginActive && !isAnimating;
  /*
   * Stable per-instance fallback when the caller didn't supply one,
   * so the prevContentLength cursor never collides between two
   * independent Markdown instances that happen to render the same
   * text. Bumped lazily so server-side / first-render parity stays
   * intact.
   */
  const anonCacheKeyRef = useRef<string | null>(null);
  if (anonCacheKeyRef.current === null) {
    anonCacheKeyRef.current = `markdown-anon-${nextAnonCacheKey++}`;
  }
  const effectiveCacheKey = cacheKey ?? anonCacheKeyRef.current;
  /*
   * Clear the cursor entry when this Markdown unmounts so the module-
   * scope map doesn't grow unbounded over a long session.
   */
  useEffect(() => {
    return () => resetWordFadeCursor(effectiveCacheKey);
  }, [effectiveCacheKey]);
  /*
   * Unified's `.use()` treats each entry as a plugin FACTORY. The
   * pre-applied form `rehypeWordFade({ cacheKey })` is the inner
   * transformer (signature `(tree) => void`); passing that directly
   * makes unified call the transformer at freeze time with no tree
   * argument — silently dropping our spans. Use the tuple form
   * `[plugin, options]` so unified invokes `plugin(options)` to obtain
   * the transformer the way every other rehype/remark plugin is
   * registered.
   */
  const rehypePlugins = useMemo(
    () =>
      pluginActive
        ? [
            ...DEFAULT_REHYPE_PLUGINS,
            [rehypeWordFade, { cacheKey: effectiveCacheKey }] as [
              typeof rehypeWordFade,
              { cacheKey: string },
            ],
          ]
        : DEFAULT_REHYPE_PLUGINS,
    [pluginActive, effectiveCacheKey],
  );
  const components = useMemo(
    () => buildComponents(hideHorizontalRules),
    [hideHorizontalRules],
  );
  const [activeEmojiPack] = useActiveEmojiPack();
  /*
   * `emojiVars` is memoized so the outer `<div>`'s `style` reference is
   * stable across renders when the active emoji pack hasn't changed.
   * Otherwise React would diff the style object identity every commit
   * and write the same custom-property declarations back to the DOM —
   * harmless but pointless work that can mask other identity issues
   * during debugging.
   */
  const emojiVars = useMemo<CSSProperties | undefined>(() => {
    if (!activeEmojiPack) return undefined;
    return Object.fromEntries(
      activeEmojiPack.sheetUrls.map((url, index) => [
        `--ai-emoji-sheet-${index}-url`,
        `url("${url}")`,
      ]),
    ) as CSSProperties;
  }, [activeEmojiPack]);
  return (
    <div style={emojiVars}>
      <Streamdown
        isAnimating={false}
        animated={pluginActive ? STREAMDOWN_SYNC_RENDER : undefined}
        className={cn(
          "markdown",
          revealSettled && "markdown--reveal-settled",
          className,
        )}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
        linkSafety={LINK_SAFETY}
      >
        {text}
      </Streamdown>
    </div>
  );
}, areMarkdownPropsEqual);
