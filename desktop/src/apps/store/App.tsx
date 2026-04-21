import { lazy, Suspense } from "react";
import { Spinner } from "@/ui/spinner";

const StoreView = lazy(() => import("@/global/store/StoreView"));

export function StoreApp() {
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
          <StoreView />
        </Suspense>
      </div>
    </div>
  );
}

export default StoreApp;
