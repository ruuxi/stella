import { createFileRoute } from "@tanstack/react-router";
import { SocialApp } from "@/app/social/App";

export const Route = createFileRoute("/social")({
  component: SocialApp,
});
