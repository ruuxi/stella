import { createLazyFileRoute } from "@tanstack/react-router";
import { SettingsApp } from "@/app/settings/App";

export const Route = createLazyFileRoute("/settings")({
  component: SettingsApp,
});
