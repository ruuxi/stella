/**
 * Store-tab nav rendered in the shell's top bar (centered) when the
 * user is on `/store`. Lifted out of the StoreView so the strip lives
 * in the global app chrome rather than nested inside the page —
 * matches the pattern the user expects from desktop apps where the
 * top bar adapts per surface (App Store, Music, etc.).
 *
 * Persists the last-active tab to localStorage on every click so
 * clicking the sidebar's Store icon reopens to wherever the user was
 * last (mirrors `apps/store/App.tsx`).
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  STORE_TAB_KEYS,
  STORE_TABS,
  type StoreTab,
} from "@/global/store/store-tabs";

const LAST_STORE_TAB_KEY = "stella.store.lastTab";

const isStoreTab = (value: unknown): value is StoreTab =>
  typeof value === "string" &&
  (STORE_TAB_KEYS as readonly string[]).includes(value);

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

  return (
    <div className="shell-topbar-store-tabs" role="tablist">
      {STORE_TABS.map((entry) => (
        <button
          key={entry.key}
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
