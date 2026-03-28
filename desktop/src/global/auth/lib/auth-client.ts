import { createAuthClient } from "better-auth/react";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { anonymousClient, magicLinkClient, jwtClient } from "better-auth/client/plugins";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";

const plugins = [convexClient(), crossDomainClient(), anonymousClient(), magicLinkClient(), jwtClient()];

// Capture the full plugin-aware return type so signIn.anonymous(), etc. are typed.
type AuthClient = ReturnType<typeof createAuthClient<{ plugins: typeof plugins }>>;

let _instance: AuthClient | null = null;

/** Lazy-initialized auth client. */
export const authClient = new Proxy({} as AuthClient, {
  get(_target, prop, receiver) {
    if (!_instance) {
      const baseURL = readConfiguredConvexSiteUrl(
        import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
      );
      if (!baseURL) {
        throw new Error("Convex site URL is not set. Cannot initialize auth client.");
      }
      _instance = createAuthClient({ baseURL, plugins });
    }
    return Reflect.get(_instance, prop, receiver);
  },
});
