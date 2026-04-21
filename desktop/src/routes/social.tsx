import { createFileRoute } from "@tanstack/react-router";
import { SocialApp } from "@/apps/social/App";

export const Route = createFileRoute("/social")({
  component: SocialApp,
});
