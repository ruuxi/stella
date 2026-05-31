import { ConvexReactClient } from "convex/react";
import { readConfiguredConvexUrl } from "@/shared/lib/convex-urls";

const convexUrl = readConfiguredConvexUrl(
  import.meta.env.VITE_CONVEX_URL as string | undefined,
);

if (!convexUrl) {
  throw new Error("VITE_CONVEX_URL is not set. Cannot initialize Convex client.");
}

export const convexClient = new ConvexReactClient(convexUrl);
