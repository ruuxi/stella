import { ConvexReactClient } from "convex/react";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!convexUrl) {
  console.warn("VITE_CONVEX_URL is not set; Convex client will be offline.");
}

export const convexClient = new ConvexReactClient(convexUrl ?? "");
