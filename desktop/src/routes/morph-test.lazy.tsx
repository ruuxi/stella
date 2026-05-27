import { createLazyFileRoute } from "@tanstack/react-router";
import { MorphTestApp } from "@/app/morph-test/App";

export const Route = createLazyFileRoute("/morph-test")({
  component: MorphTestApp,
});
