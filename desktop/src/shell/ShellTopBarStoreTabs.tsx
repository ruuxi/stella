/**
 * Store-tab nav rendered in the shell's top bar (centered) when the
 * user is on `/store`. Lifted out of the StoreView so the strip lives
 * in the global app chrome rather than nested inside the page —
 * matches the pattern the user expects from desktop apps where the
 * top bar adapts per surface (App Store, Music, etc.).
 *
 * Persists the last-active tab to localStorage on every click so
 * clicking the sidebar's Store icon reopens to wherever the user was
 * last (mirrors `app/store/App.tsx`).
 *
 * The active tab is highlighted by a single absolutely-positioned
 * indicator pill that slides between buttons, instead of repainting
 * each button's own background — gives the strip a smooth segmented-
 * control feel and avoids the pill clipping against the container's
 * rounded edges on the leftmost/rightmost tabs.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  STORE_TAB_KEYS,
  STORE_TABS,
  type StoreTab,
} from "@/global/store/store-tabs";

const LAST_STORE_TAB_KEY = "stella.store.lastTab";

const isStoreTab = (value: unknown): value is StoreTab =>
  typeof value === "string" &&
  (STORE_TAB_KEYS as readonly string[]).includes(value);

type IndicatorRect = { left: number; width: number };

export function ShellTopBarStoreTabs() {
  const navigate = useNavigate();
  // We can't use `useSearch` here because this component is mounted
  // outside the route tree (it sits in the shell). Read the search
  // string off `useRouterState` instead.
  const search = useRouterState({ select: (state) => state.location.search });
  const tabFromSearch = (() => {
    if (!search || typeof search !== "object") return null;
    const value = (search as { tab?: unknown }).tab;
    return isStoreTab(value) ? value : null;
  })();
  const activeTab: StoreTab = tabFromSearch ?? STORE_TABS[0]!.key;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<StoreTab, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState<IndicatorRect | null>(null);
  const [hasMeasured, setHasMeasured] = useState(false);

  const handleClick = useCallback(
    (next: StoreTab) => {
      try {
        window.localStorage?.setItem(LAST_STORE_TAB_KEY, next);
      } catch {
        // ignore storage failures
      }
      void navigate({ to: "/store", search: { tab: next }, replace: true });
    },
    [navigate],
  );

  const measure = useCallback(() => {
    const container = containerRef.current;
    const node = tabRefs.current.get(activeTab);
    if (!container || !node) return;
    const cRect = container.getBoundingClientRect();
    const nRect = node.getBoundingClientRect();
    setIndicator({
      left: nRect.left - cRect.left,
      width: nRect.width,
    });
  }, [activeTab]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Defer the "animate transitions" flag by one frame after the first
  // measurement, so the indicator snaps into place without animating
  // from its (0,0) initial position on mount.
  useEffect(() => {
    if (indicator && !hasMeasured) {
      const id = window.requestAnimationFrame(() => setHasMeasured(true));
      return () => window.cancelAnimationFrame(id);
    }
  }, [indicator, hasMeasured]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    for (const node of tabRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div ref={containerRef} className="shell-topbar-store-tabs" role="tablist">
      <span
        className="shell-topbar-store-tab-indicator"
        aria-hidden="true"
        data-visible={indicator ? "true" : undefined}
        data-animated={hasMeasured ? "true" : undefined}
        style={
          indicator
            ? {
                transform: `translateX(${indicator.left}px)`,
                width: `${indicator.width}px`,
              }
            : undefined
        }
      />
      {STORE_TABS.map((entry) => (
        <button
          key={entry.key}
          ref={(el) => {
            if (el) tabRefs.current.set(entry.key, el);
            else tabRefs.current.delete(entry.key);
          }}
          type="button"
          role="tab"
          aria-selected={activeTab === entry.key}
          className="shell-topbar-store-tab"
          data-active={activeTab === entry.key || undefined}
          onClick={() => handleClick(entry.key)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
