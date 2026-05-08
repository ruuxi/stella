import { createFileRoute } from "@tanstack/react-router";
import { GrCanvasApp } from "@/app/gr-canvas/App";

export const Route = createFileRoute("/gr-canvas")({
  component: GrCanvasApp,
});
