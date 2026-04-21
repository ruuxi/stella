import { createFileRoute } from "@tanstack/react-router";
import { StoreApp } from "@/apps/store/App";

export const Route = createFileRoute("/store")({
  component: StoreApp,
});
