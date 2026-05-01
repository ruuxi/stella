import type { ComponentType, SVGProps } from "react";

/**
 * Per-app sidebar metadata. Each `desktop/src/app/<id>/metadata.ts` file
 * exports a default of this shape. The Sidebar discovers all metadata files
 * via a relative `import.meta.glob` (see `desktop/src/shell/sidebar/Sidebar.tsx`
 * — the glob pattern lives there) and renders one nav entry per app.
 * Feature folders that omit `metadata.ts` (e.g. `home`, `media`, `workspace`)
 * are skipped by the glob — sidebar presence is opt-in per feature.
 *
 * To add a new sidebar app, agents should:
 *   1. Create `desktop/src/app/<id>/metadata.ts` (this shape).
 *   2. Create `desktop/src/app/<id>/App.tsx` (the route component).
 *   3. Create `desktop/src/routes/<id>.tsx` (file-system route, optionally
 *      with a zod search-param validator).
 *
 * Vite + the TanStack Router plugin pick the new route up via HMR; the
 * sidebar reflects the new entry on the next render. No edits to the
 * sidebar or any registry are required.
 */
export type AppSlot = "top" | "bottom";

export type AppIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

export type AppMetadata = {
  /** Stable identifier (matches the routes/<id>.tsx filename). */
  id: string;
  /** Human-visible label rendered next to the icon in the sidebar. */
  label: string;
  /** Icon component (e.g. one of `@/shell/sidebar/SidebarIcons`). */
  icon: AppIcon;
  /** Router path (e.g. `/chat`). Sidebar renders a `<Link to={route} />`. */
  route: string;
  /** Whether the entry sits in the top nav or the bottom footer. */
  slot: AppSlot;
  /** Sort order within the slot (lower first). Defaults to 100. */
  order?: number;
  /**
   * When true, the sidebar omits this app from its rendered list. The route
   * itself remains reachable (`routes/<id>.tsx` is unaffected) — useful for
   * apps that should be navigable via deep link / dropdown but not occupy a
   * permanent slot in the rail. Defaults to `false`.
   */
  hideFromSidebar?: boolean;
  /**
   * Optional handler invoked when the user clicks the sidebar entry while it
   * is *already* the active route. Use this to implement "scroll to top",
   * "show home", or other re-entry behaviors. When provided, the click also
   * `preventDefault()`s the underlying `<Link>` navigation.
   */
  onActiveClick?: () => void;
};
