import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SettingsApp } from "@/apps/settings/App";
import { SETTINGS_TAB_KEYS } from "@/global/settings/settings-tabs";

/**
 * `?tab=<id>` deep-links to a specific settings tab.
 */
const SettingsSearch = z.object({
  tab: z.enum(SETTINGS_TAB_KEYS).optional(),
});

export const Route = createFileRoute("/settings")({
  validateSearch: SettingsSearch,
  component: SettingsApp,
});
