import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Accept any string for `tab` so legacy URLs (`?tab=installed`,
// `?tab=publish`) still parse — `StoreApp` normalizes the value via
// `normalizeStoreTab` before reading it.
const StoreSearch = z.object({
  tab: z.string().optional(),
  // Deep-link to a specific add-on detail view. Used by creator pages
  // and shareable links. `StoreApp` forwards it to the hosted store.
  package: z.string().optional(),
});

export const Route = createFileRoute("/store")({
  validateSearch: StoreSearch,
});
