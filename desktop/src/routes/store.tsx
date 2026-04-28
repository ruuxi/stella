import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { StoreApp } from "@/apps/store/App";
import { STORE_TAB_KEYS } from "@/global/store/store-tabs";

const StoreSearch = z.object({
  tab: z.enum(STORE_TAB_KEYS).optional(),
});

export const Route = createFileRoute("/store")({
  validateSearch: StoreSearch,
  component: StoreApp,
});
