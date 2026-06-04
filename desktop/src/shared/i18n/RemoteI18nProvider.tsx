import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  I18nProviderBase,
  type I18nProviderProps,
} from "./I18nProvider";
import type { Locale } from "./locales";

type PersistRemoteLocale = (locale: Locale) => void | Promise<unknown>;

export function I18nProvider({ children }: I18nProviderProps) {
  const remotePreference = useQuery(api.data.preferences.getLocale, {});
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
