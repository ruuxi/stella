import type { CSSProperties, ImgHTMLAttributes } from "react";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  Streamdown,
  createAnimatePlugin,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";
import { cn } from "@/shared/lib/utils";
import {
  hasCompleteEmojiSpritePack,
  useActiveEmojiPack,
} from "./emoji-sprites/active-emoji-pack";
import { remarkEmojiSprites } from "./emoji-sprites/remark-emoji-sprites";
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
  /** Suppress GFM horizontal rules (`---`). Used in chat bubbles where
   *  models often append a trailing rule that reads as a message divider. */
  hideHorizontalRules?: boolean;
  /**
   * When `true`, freshly-arriving characters fade in one-by-one at a fixed
   * rate (Claude-style stream). When the assistant message finishes streaming
   * the caller flips this to `false` and Streamdown drops the per-character
   * `<span>` wrappers so completed messages render as plain text.
   *
   * The default is `false`, so non-chat consumers (BlueprintDialog,
   * markdown file previews) render without any animation overhead.
   */
  isStreaming?: boolean;
}

/*
 * Per-character fade-in animation for the live assistant stream.
 *
 * Streamdown's animate plugin assigns each NEW character (past the previously
 * rendered char count) a CSS animation with `--sd-delay = newIndex * stagger`,
 * so the visible reveal rate stays at ~`1000 / stagger` chars/sec regardless
 * of how chunky upstream tokens arrive — the "fixed character stream speed"
 * the design calls for.
 *
 * `stagger` is tuned slightly higher than an average adult reading speed
 * (~250 wpm ≈ 21 cps ≈ 48ms/char): 22ms/char ≈ 45 cps ≈ 540 wpm. `duration`
 * is the per-character fade length; keeping it noticeably larger than
 * `stagger` makes adjacent characters' fades overlap so the reveal reads as
 * a smooth wave rather than a series of pops.
 */
const STREAMING_ANIMATION = {
  animation: "fadeIn",
  sep: "char",
  stagger: 22,
  duration: 220,
  easing: "ease-out",
} as const;

/*
 * Module-level cache of animate plugins, keyed by the row's stable
 * `cacheKey`. The cache exists because the chat timeline is virtualized
 * (`@legendapp/list` in `ChatTimeline.tsx`): scrolling past the streaming
 * row unmounts it. If we let Streamdown manage the animate plugin via its
 * `animated`/`isAnimating` props, that plugin lives inside a `useMemo`
 * tied to the Streamdown component instance, so the remount creates a
 * fresh plugin with `prevContentLength = 0` — and every already-revealed
 * character is treated as "new" and re-fades from zero.
 *
 * Hoisting the plugin out here keeps its internal `lastRenderCharCount`
 * across unmount/remount, so on the next render after a remount we mirror
 * Streamdown's own `setPrevContentLength(getLastRenderCharCount())` dance
 * (see Streamdown's `Block` component) and the rehype pass marks all
 * previously-shown characters with `duration: 0`. Only the genuinely-new
 * characters added while the row was off-screen animate.
 */
type StreamingAnimatePlugin = ReturnType<typeof createAnimatePlugin>;
const streamingAnimatePlugins = new Map<string, StreamingAnimatePlugin>();

const getOrCreateStreamingAnimatePlugin = (
  cacheKey: string,
): StreamingAnimatePlugin => {
  let plugin = streamingAnimatePlugins.get(cacheKey);
  if (!plugin) {
    plugin = createAnimatePlugin(STREAMING_ANIMATION);
    streamingAnimatePlugins.set(cacheKey, plugin);
  }
  return plugin;
};

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
 * `BASE_REMARK_PLUGINS` is the default Streamdown set. The emoji sprite
 * plugin is added only when a complete active pack is present; otherwise
 * native Unicode emoji must remain visible.
 */
const DEFAULT_REMARK_PLUGINS = Object.values(defaultRemarkPlugins);
const BASE_REMARK_PLUGINS = [...DEFAULT_REMARK_PLUGINS];

/*
 * Streamdown's `rehypePlugins` prop, like `remarkPlugins`, *replaces*
 * its defaults — re-spread them so harden / sanitize / raw stay in
 * place. The word-fade plugin appends after them so it observes the
 * post-sanitize HAST (and inherits the same allow-list).
 */
const DEFAULT_REHYPE_PLUGINS = Object.values(defaultRehypePlugins);

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
  Boolean(prev.hideHorizontalRules) === Boolean(next.hideHorizontalRules) &&
  Boolean(prev.isStreaming) === Boolean(next.isStreaming);

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
  hideHorizontalRules = false,
  isStreaming = false,
}: MarkdownProps) {
  /*
   * Stable per-instance fallback when the caller didn't supply one,
   * matching Streamdown's per-row parse/cache expectations. Bumped
   * lazily so server-side / first-render parity stays intact.
   */
  const anonCacheKeyRef = useRef<string | null>(null);
  if (anonCacheKeyRef.current === null) {
    anonCacheKeyRef.current = `markdown-anon-${nextAnonCacheKey++}`;
  }
  const effectiveCacheKey = cacheKey ?? anonCacheKeyRef.current;
  const components = useMemo(
    () => buildComponents(hideHorizontalRules),
    [hideHorizontalRules],
  );
  const [activeEmojiPack] = useActiveEmojiPack();
  const emojiSpritesEnabled = hasCompleteEmojiSpritePack(activeEmojiPack);
  const remarkPlugins = useMemo(
    () =>
      emojiSpritesEnabled
        ? [...BASE_REMARK_PLUGINS, remarkEmojiSprites]
        : BASE_REMARK_PLUGINS,
    [emojiSpritesEnabled],
  );
  /*
   * `emojiVars` is memoized so the outer `<div>`'s `style` reference is
   * stable across renders when the active emoji pack hasn't changed.
   * Otherwise React would diff the style object identity every commit
   * and write the same custom-property declarations back to the DOM —
   * harmless but pointless work that can mask other identity issues
   * during debugging.
   */
  const emojiVars = useMemo<CSSProperties | undefined>(() => {
    if (!emojiSpritesEnabled || !activeEmojiPack) return undefined;
    return Object.fromEntries(
      activeEmojiPack.sheetUrls.map((url, index) => [
        `--ai-emoji-sheet-${index}-url`,
        `url("${url}")`,
      ]),
    ) as CSSProperties;
  }, [activeEmojiPack, emojiSpritesEnabled]);
  /*
   * Streaming-only animation wiring. While `isStreaming` is true we pull a
   * persisted animate plugin out of the module-level cache and append it to
   * the rehype chain ourselves (rather than letting Streamdown manage one
   * via its `animated` prop, which would reset across virtualization
   * unmounts — see the cache comment near the top of this file).
   *
   * Once `isStreaming` flips to false, the plugin drops out of the rehype
   * chain entirely so the persisted message renders as plain text with no
   * `<span data-sd-animate>` overhead, and the cache entry is released.
   */
  const animatePlugin = isStreaming
    ? getOrCreateStreamingAnimatePlugin(effectiveCacheKey)
    : null;
  if (animatePlugin) {
    // Mirror Streamdown's internal `Block` wiring: before the upcoming
    // rehype pass, set `prevContentLength` to whatever the previous pass
    // produced. On a fresh mount after a virtualization unmount, this is
    // the char count from the last on-screen render — so only newly-added
    // characters animate, not the entire message body.
    animatePlugin.setPrevContentLength(animatePlugin.getLastRenderCharCount());
  }
  useEffect(() => {
    if (isStreaming) return;
    streamingAnimatePlugins.delete(effectiveCacheKey);
  }, [effectiveCacheKey, isStreaming]);
  const rehypePlugins = useMemo(
    () =>
      animatePlugin
        ? [...DEFAULT_REHYPE_PLUGINS, animatePlugin.rehypePlugin]
        : DEFAULT_REHYPE_PLUGINS,
    [animatePlugin],
  );
  const streamdownKey = `${effectiveCacheKey}:${emojiSpritesEnabled ? "emoji" : "plain"}`;
  return (
    <div style={emojiVars}>
      <Streamdown
        key={streamdownKey}
        className={cn("markdown", className)}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        linkSafety={LINK_SAFETY}
      >
        {text}
      </Streamdown>
    </div>
  );
}, areMarkdownPropsEqual);
