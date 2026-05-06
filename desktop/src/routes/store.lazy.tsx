import { createLazyFileRoute } from "@tanstack/react-router";
import { StoreApp } from "@/app/store/App";

export const Route = createLazyFileRoute("/store")({
  component: StoreApp,
});
