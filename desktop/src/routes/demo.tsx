import { createFileRoute } from "@tanstack/react-router";
import { DemoApp } from "@/apps/demo/App";

export const Route = createFileRoute("/demo")({
  component: DemoApp,
});
