import { lazy, Suspense, useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { StoreTab } from "@/global/store/store-tabs";
import { Spinner } from "@/ui/spinner";

const StoreView = lazy(() => import("@/global/store/StoreView"));

export function StoreApp() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/store" });

  const handleActiveTabChange = useCallback(
    (tab: StoreTab) => {
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
            activeTab={search.tab}
            onActiveTabChange={handleActiveTabChange}
          />
        </Suspense>
      </div>
    </div>
  );
}

export default StoreApp;
