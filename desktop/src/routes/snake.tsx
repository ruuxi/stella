import { createFileRoute } from "@tanstack/react-router";
import { SnakeApp } from "@/apps/snake/App";

export const Route = createFileRoute("/snake")({
  component: SnakeApp,
});
