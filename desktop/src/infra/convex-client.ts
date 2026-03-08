import { ConvexReactClient } from "convex/react";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!convexUrl) {
  throw new Error("VITE_CONVEX_URL is not set. Cannot initialize Convex client.");
}

export const convexClient = new ConvexReactClient(convexUrl);
