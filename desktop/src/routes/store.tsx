import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { StoreApp } from "@/app/store/App";

// Accept any string for `tab` so legacy URLs (`?tab=installed`,
// `?tab=publish`) still parse — `StoreApp` normalizes the value via
// `normalizeStoreTab` before reading it.
const StoreSearch = z.object({
  tab: z.string().optional(),
  // Deep-link to a specific add-on detail view. Used by creator pages
  // and shareable links. `StoreApp` reads it and pushes it down to
  // `StoreView` to set `selectedPackageId`.
  package: z.string().optional(),
});

export const Route = createFileRoute("/store")({
  validateSearch: StoreSearch,
  component: StoreApp,
});
