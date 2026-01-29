import type { AuthConfig } from "convex/server";
import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";

export default {
  providers: [
    getAuthConfigProvider(),
    {
      applicationID: "convex",
      domain: process.env.CONVEX_SITE_URL!,
    },
  ],
} satisfies AuthConfig;
