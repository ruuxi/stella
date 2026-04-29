import { lazy, Suspense, useCallback, useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  DEFAULT_STORE_TAB,
  normalizeStoreTab,
  type StoreTab,
} from "@/global/store/store-tabs";
import { Spinner } from "@/ui/spinner";

const StoreView = lazy(() => import("@/global/store/StoreView"));

// Persist the last-active Store tab so clicking the global sidebar's Store
// icon reopens to wherever the user was last (Discover by default). The URL
// query param is still the source of truth while inside Store; this only
// fires when no `?tab=` is present on entry.
const LAST_STORE_TAB_KEY = "stella.store.lastTab";

const readStoredTab = (): StoreTab => {
  try {
    const raw = window.localStorage?.getItem(LAST_STORE_TAB_KEY);
    return normalizeStoreTab(raw);
  } catch {
    return DEFAULT_STORE_TAB;
  }
};

export function StoreApp() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/store" });

  const requestedTab = normalizeStoreTab(search.tab);
  const urlIsLegacy = typeof search.tab === "string" && search.tab !== requestedTab;

  // Two redirects share this effect:
  //   - Legacy `?tab=installed`/`?tab=publish` URLs collapse to Discover.
  //   - First entry without any tab param goes to the user's last-saved tab.
  useEffect(() => {
    if (urlIsLegacy) {
      void navigate({
        to: "/store",
        search: { tab: requestedTab },
        replace: true,
      });
      return;
    }
    if (search.tab) return;
    const stored = readStoredTab();
    if (stored === DEFAULT_STORE_TAB) return;
    void navigate({ to: "/store", search: { tab: stored }, replace: true });
  }, [navigate, search.tab, urlIsLegacy, requestedTab]);

  const handleActiveTabChange = useCallback(
    (tab: StoreTab) => {
      try {
        window.localStorage?.setItem(LAST_STORE_TAB_KEY, tab);
      } catch {
        // ignore storage failures
      }
      void navigate({
        to: "/store",
        search: { tab },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <Suspense
          fallback={
            <div className="workspace-placeholder">
              <Spinner size="md" />
            </div>
          }
        >
          <StoreView
            activeTab={requestedTab}
            onActiveTabChange={handleActiveTabChange}
            initialPackageId={
              typeof search.package === "string" && search.package.trim()
                ? search.package
                : undefined
            }
          />
        </Suspense>
      </div>
    </div>
  );
}

export default StoreApp;
