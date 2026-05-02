import { createFileRoute } from "@tanstack/react-router";
import { SnakeApp } from "@/app/snake/App";

export const Route = createFileRoute("/snake")({
  component: SnakeApp,
});
