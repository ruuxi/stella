import { createAuthClient } from "better-auth/react";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { anonymousClient, magicLinkClient, jwtClient } from "better-auth/client/plugins";

const baseURL = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;

const plugins = [convexClient(), crossDomainClient(), anonymousClient(), magicLinkClient(), jwtClient()];

export const authClient = createAuthClient({
  baseURL: baseURL ?? "",
  plugins,
});
