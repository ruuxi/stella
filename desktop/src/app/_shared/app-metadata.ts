import type { ComponentType, SVGProps } from "react";

/**
 * Per-app top-bar nav metadata. Each `desktop/src/app/<id>/metadata.ts`
 * file exports a default of this shape. The top-bar nav discovers all
 * metadata files via a relative `import.meta.glob` (see
 * `desktop/src/shell/sidebar/app-registry.ts` — the glob pattern lives
 * there) and renders one nav entry per app. Feature folders that omit
 * `metadata.ts` (e.g. `home`, `media`, `workspace`) are skipped by the
 * glob — nav presence is opt-in per feature.
 *
 * Keep `app/<id>` focused on route surfaces, metadata, and thin route-shell
 * composition. Reusable implementation should live in the owning `global/`,
 * `features/`, `shell/`, or `platform/` home instead of accumulating here.
 *
 * To add a new sidebar app, agents should:
 *   1. Create `desktop/src/app/<id>/metadata.ts` (this shape).
 *   2. Create `desktop/src/app/<id>/App.tsx` (the route component).
 *   3. Create `desktop/src/routes/<id>.tsx` (file-system route, optionally
 *      with a zod search-param validator).
 *
 * Vite + the TanStack Router plugin pick the new route up via HMR; the
 * top-bar nav reflects the new entry on the next render. No edits to
 * the nav or any registry are required.
 */
type AppSlot = "top" | "bottom";

type AppIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

export type AppMetadata = {
  /** Stable identifier (matches the routes/<id>.tsx filename). */
  id: string;
  /** Human-visible label rendered next to the icon in the sidebar. */
  label: string;
  /** Icon component (e.g. one of `@/ui/nav-icons`). */
  icon: AppIcon;
  /** Router path (e.g. `/chat`). Renders a `<Link to={route} />`. */
  route: string;
  /**
   * Where the entry lives. `"top"` puts it in the primary top-bar nav
   * (Home / Store / Social). `"bottom"` apps are reachable via the
   * Settings menu in the top-bar nav rather than as a dedicated nav button.
   */
  slot: AppSlot;
  /** Sort order within the slot (lower first). Defaults to 100. */
  order?: number;
  /**
   * When true, the top-bar nav omits this app from its rendered list. The
   * route itself remains reachable (`routes/<id>.tsx` is unaffected) —
   * useful for apps that should be navigable via deep link / dropdown but
   * not occupy a permanent slot in the bar. Defaults to `false`.
   */
  hideFromSidebar?: boolean;
  /**
   * Optional handler invoked when the user clicks the nav entry while it
   * is *already* the active route. Use this to implement "scroll to top",
   * "show home", or other re-entry behaviors. When provided, the click
   * also `preventDefault()`s the underlying `<Link>` navigation.
   */
  onActiveClick?: () => void;
  /** When true, the nav never paints the active/selected row styling. */
  suppressActiveState?: boolean;
};
