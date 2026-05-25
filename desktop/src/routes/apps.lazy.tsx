import { createLazyFileRoute } from "@tanstack/react-router";
import { AppsApp } from "@/app/apps/App";

export const Route = createLazyFileRoute("/apps")({
  component: AppsApp,
});
