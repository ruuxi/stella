import { createLazyFileRoute } from "@tanstack/react-router";
import { SocialApp } from "@/app/social/App";

export const Route = createLazyFileRoute("/social")({
  component: SocialApp,
});
