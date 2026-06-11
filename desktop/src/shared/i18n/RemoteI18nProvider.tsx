import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthBootstrapState } from "@/global/auth/DesktopConvexAuthProvider";
import {
  I18nProviderBase,
  type I18nProviderProps,
} from "./I18nProvider";
import type { Locale } from "./locales";

type PersistRemoteLocale = (locale: Locale) => void | Promise<unknown>;

export function I18nProvider({ children }: I18nProviderProps) {
  // Gate the remote locale subscription until runtime auth resolves so it does
  // not register against an unauthenticated client and churn on first paint.
  // The local locale (shared UI state + navigator) still renders first via
  // `I18nProviderBase`; the remote value is purely an override applied once it
  // resolves, and `undefined` (skip) leaves the local value in place.
  const { runtimeAuthReady } = useAuthBootstrapState();
  const remotePreference = useQuery(
    api.data.preferences.getLocale,
    runtimeAuthReady ? {} : "skip",
  );
  const saveRemoteLocale = useMutation(api.data.preferences.setLocale);
  const persistRemoteLocale = useCallback<PersistRemoteLocale>(
    (locale) => saveRemoteLocale({ locale }),
    [saveRemoteLocale],
  );

  return (
    <I18nProviderBase
      remotePreference={remotePreference}
      persistRemoteLocale={persistRemoteLocale}
    >
      {children}
    </I18nProviderBase>
  );
}
