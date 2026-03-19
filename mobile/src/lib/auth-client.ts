import { expoClient } from "@better-auth/expo/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { jwtClient, magicLinkClient } from "better-auth/client/plugins";
import * as SecureStore from "expo-secure-store";
import { env } from "../config/env";
import { assert } from "./assert";

const plugins = [
  expoClient({
    scheme: env.mobileScheme,
    storage: SecureStore,
    storagePrefix: "stella-mobile",
  }),
  convexClient(),
  magicLinkClient(),
  jwtClient(),
];

type AuthClient = ReturnType<typeof createAuthClient<{ plugins: typeof plugins }>>;

let instance: AuthClient | null = null;

export const authClient = new Proxy({} as AuthClient, {
  get(_target, prop, receiver) {
    if (!instance) {
      assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
      instance = createAuthClient({
        baseURL: env.convexSiteUrl,
        plugins,
      });
    }

    return Reflect.get(instance, prop, receiver);
  },
});
