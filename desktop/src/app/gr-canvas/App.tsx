import { lazy, Suspense } from "react";
import { Spinner } from "@/ui/spinner";
import "./gr-canvas.css";

const GrCanvasView = lazy(() =>
  import("./GrCanvasView").then((m) => ({ default: m.GrCanvasView })),
);

export function GrCanvasApp() {
  return (
    <Suspense
      fallback={
        <div className="gr-canvas-placeholder">
          <Spinner size="md" />
        </div>
      }
    >
      <GrCanvasView />
    </Suspense>
  );
}

export default GrCanvasApp;
