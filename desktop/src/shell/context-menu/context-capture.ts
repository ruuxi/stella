import {
  deriveContextContainerLabel,
  resolveContextContainers,
  type ResolvedContainers,
} from "@/shared/lib/stella-context-containers";
import { buildDomSnapshot } from "@/shared/lib/stella-dom-snapshot";

/**
 * Context capture for the in-app right-click menu.
 *
 * Walks up from a click target to find two scoped containers:
 *   - "tight" — the nearest meaningful section around the click
 *   - "broad" — a larger ancestor (or the full content area)
 *
 * Then builds a compact text snapshot of each subtree using the same
 * approach as stella-ui-handler, but scoped to the resolved container.
 *
 * No dependency on data-stella-* annotations, fixed view types, or any
 * self-mod-mutable schema. Reads the live DOM as-is.
 */

const SCOPED_SNAPSHOT_SKIP_TAGS = new Set(["script", "style", "noscript", "svg"]);

// ---------------------------------------------------------------------------
// Scoped snapshot builder
// ---------------------------------------------------------------------------

/**
 * Build a compact text snapshot of a DOM subtree.
 * Viewport-filtered, capped at `maxLines` to keep context concise.
 */
export function buildScopedSnapshot(root: Element, maxLines = 60): string {
  return buildDomSnapshot({
    root,
    maxLines,
    requireViewportIntersection: true,
    capIndentDepth: 6,
    skipTags: SCOPED_SNAPSHOT_SKIP_TAGS,
    skipUnnamedInteractive: true,
  });
}

// ---------------------------------------------------------------------------
// Public API: capture context at right-click time
// ---------------------------------------------------------------------------

export type CapturedContext = {
  /** Snapshot of the tight (local) container. */
  tightSnapshot: string;
  /** Snapshot of the broad (wider) container. */
  broadSnapshot: string;
  /** A short human-readable label for what the user clicked near. */
  contextLabel: string;
  /** The resolved containers (for highlight rendering). */
  containers: ResolvedContainers;
};

/**
 * Capture full context from a right-click event.
 * Call synchronously from the contextmenu/mousedown handler.
 */
export function captureContextAtPoint(target: Element): CapturedContext {
  const containers = resolveContextContainers(target);
  const tightSnapshot = buildScopedSnapshot(containers.tight, 40);
  const broadSnapshot = buildScopedSnapshot(containers.broad, 80);
  const contextLabel = deriveContextContainerLabel(containers.tight);

  return {
    tightSnapshot,
    broadSnapshot,
    contextLabel,
    containers,
  };
}
