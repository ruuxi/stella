import { lazy, Suspense } from "react";
import { Spinner } from "@/ui/spinner";

const SnakeGame = lazy(() =>
  import("./SnakeGame").then((m) => ({ default: m.SnakeGame })),
);

export function SnakeApp() {
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
          <SnakeGame />
        </Suspense>
      </div>
    </div>
  );
}

export default SnakeApp;
