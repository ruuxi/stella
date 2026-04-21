import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SettingsApp } from "@/apps/settings/App";

/**
 * `?tab=<id>` deep-links to a specific settings tab.
 */
const SettingsSearch = z.object({
  tab: z.enum(["basic", "models", "audio", "connections"]).optional(),
});

export const Route = createFileRoute("/settings")({
  validateSearch: SettingsSearch,
  component: SettingsApp,
});
