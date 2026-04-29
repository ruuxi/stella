/**
 * workspace panel tab manager — type definitions.
 *
 * Modeled after the right-side panel in the Codex desktop app: a generic
 * tabs container where each tab carries its own viewer component, dedups by
 * a stable string id, and opening a tab implicitly opens the panel.
 */

import type { ReactNode } from "react";

/**
 * Discriminator for the kind of content a tab is showing. Used for icons,
 * grouping, and click-handler routing. Mirrors `ArtifactTabContent`'s
 * `importKind` in Codex but keeps Stella-specific variants (html, video,
 * audio, model3d, download, text) since the workspace panel fans out wider.
 */
export type DisplayTabKind =
  | "chat"
  | "html"
  | "url"
  | "markdown"
  | "source-diff"
  | "image"
  | "pdf"
  | "office-document"
  | "office-spreadsheet"
  | "office-slides"
  | "video"
  | "audio"
  | "model3d"
  | "download"
  | "text"
  | "ideas"
  | "trash"
  | "store";

/**
 * Stable, dedup-able description of what a tab represents. Two specs with
 * the same `id` refer to "the same tab" — a second `openTab` call will
 * replace its props and re-activate, never stack.
 *
 * Convention for ids:
 *   - `media:image:<sorted joined paths>`
 *   - `media:video:<path>`
 *   - `media:audio:<path>`
 *   - `media:model3d:<path>`
 *   - `media:download:<path>`
 *   - `media:text:<sha256-of-text>` (unique per text blob)
 *   - `office:<sourcePath>`
 *   - `pdf:<filePath>`
 *   - `html:<hash>` (or `html:singleton` for the legacy single-HTML stream)
 */
export type DisplayTabSpec = {
  id: string;
  kind: DisplayTabKind;
  title: string;
  tooltip?: string;
  /**
   * Component renderer. Receives nothing — the spec captures all inputs the
   * viewer needs in its closure, mirroring how Codex's `openTab(state, C, {
   * props })` snapshots props at registration time.
   */
  render: () => ReactNode;
  /**
   * Optional opaque metadata used for dedup-by-resource and analytics.
   * Currently unused by the store but kept on the spec so the chat surface
   * can know "is there already a tab for this exact file path?"
   */
  metadata?: Record<string, unknown>;
};

export type DisplayTab = DisplayTabSpec & {
  /** Monotonic insertion order — used by the tab strip to paint left→right. */
  ord: number;
};

/**
 * Options for `openTab`.
 */
export type OpenTabOptions = {
  /**
   * Whether opening should also activate the tab + open the panel. Defaults
   * to `true`. Set to `false` to register a tab passively (e.g. when
   * pre-warming a viewer) without stealing focus.
   */
  activate?: boolean;
  /**
   * Whether the panel itself should be opened as part of this mutation.
   *
   * Defaults to:
   *   - `true` when `activate === true`
   *   - current `panelOpen` state when `activate === false`
   *
   * This lets callers update a tab while the panel is closed and make it the
   * next active tab without popping the UI open immediately.
   */
  openPanel?: boolean;
};
