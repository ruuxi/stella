/* eslint-disable react-refresh/only-export-components */
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Page-sidebar override system.
 *
 * Lets a page (e.g. `/settings`) replace the *contents* of the main sidebar
 * with its own nav while it's mounted. The shell continues to render the
 * title bar, brand row, account row, etc. — only the middle nav region
 * swaps. The shell also auto-renders a "Back" button at the top of the
 * override; it navigates via TanStack’s memory `history` (not
 * `window.history`).
 *
 * Why this pattern (vs. a fixed double-sidebar):
 *   * Most app routes only need a sidebar of their own occasionally; a
 *     dedicated rail per app eats horizontal space and forces a visual
 *     "this app is special" affordance every time.
 *   * Pages register declaratively via `<PageSidebar>`; on unmount the
 *     override clears automatically, so there's no risk of a stale
 *     override lingering after navigation.
 *   * The override owns its own ReactNode subtree, so it can hold local
 *     state (active-tab selection, etc.) without round-tripping through
 *     the shell.
 *
 * To consume from a page:
 *
 *   import { PageSidebar } from "@/context/page-sidebar";
 *
 *   function MyPage() {
 *     return (
 *       <>
 *         <PageSidebar title="My App">
 *           <button>...</button>
 *         </PageSidebar>
 *         {/* page content *\/}
 *       </>
 *     );
 *   }
 */

type PageSidebarConfig = {
  title?: string;
  content: ReactNode;
};

type PageSidebarContextValue = {
  override: PageSidebarConfig | null;
  setOverride: (config: PageSidebarConfig | null) => void;
};

const PageSidebarContext = createContext<PageSidebarContextValue | null>(null);

export function PageSidebarProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<PageSidebarConfig | null>(null);
  const value = useMemo(() => ({ override, setOverride }), [override]);
  return (
    <PageSidebarContext.Provider value={value}>
      {children}
    </PageSidebarContext.Provider>
  );
}

/** Read-only access to the active page-sidebar override (used by the shell). */
export function usePageSidebarOverride(): PageSidebarConfig | null {
  const ctx = useContext(PageSidebarContext);
  return ctx?.override ?? null;
}

/**
 * Imperative setter for the page-sidebar override. Most pages should use
 * `<PageSidebar>` instead — this is exposed for advanced cases (e.g. setting
 * the override from outside React's render tree).
 */
export function useSetPageSidebar() {
  const ctx = useContext(PageSidebarContext);
  if (!ctx) {
    throw new Error(
      "useSetPageSidebar must be used inside a <PageSidebarProvider>",
    );
  }
  return ctx.setOverride;
}

interface PageSidebarProps {
  /** Shown next to the back button at the top of the override. */
  title?: string;
  /** The nav rendered in place of the default sidebar nav. */
  children: ReactNode;
}

/**
 * Declarative page-sidebar override. Mount this anywhere inside a route to
 * replace the main sidebar's nav with `children` until the route unmounts.
 *
 * Render-prop-style children are intentionally avoided: the override lives
 * in the same React tree as the page (rendered into the sidebar via
 * context), so its state stays co-located with the page that owns it.
 */
export function PageSidebar({ title, children }: PageSidebarProps) {
  const setOverride = useSetPageSidebar();

  // Memoize the config so identity only changes when title/children change —
  // this keeps the shell's `useMemo`/render path stable across re-renders
  // that don't actually mutate the sidebar.
  const config = useMemo<PageSidebarConfig>(
    () => ({ title, content: children }),
    [title, children],
  );

  useEffect(() => {
    setOverride(config);
    return () => setOverride(null);
  }, [config, setOverride]);

  return null;
}

/**
 * Pops the **TanStack** history stack (memory history in Electron), not
 * `window.history` — the latter is wrong for this app and no-ops the Back
 * button. Falls back to `/chat` when there is no prior entry (e.g. user
 * landed on `/settings` directly).
 */
export function useDefaultPageSidebarBack() {
  const router = useRouter();
  const navigate = useNavigate();

  return useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/chat" });
    }
  }, [navigate, router.history]);
}
