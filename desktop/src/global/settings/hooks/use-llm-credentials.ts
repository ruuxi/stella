import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalLlmCredentialSummary,
  LocalLlmOAuthProviderSummary,
} from "@/shared/types/electron";

/**
 * Fired the first time a non-Stella LLM provider transitions from "not
 * connected" to "connected" on this device. Listeners (notably the
 * `ProviderConnectedDialog` mounted at the app root) can offer to route the
 * Assistant / Image / Voice surfaces through the newly connected provider
 * in one click instead of forcing the user to flip each setting by hand.
 */
export const PROVIDER_CONNECTED_EVENT = "stella:llm-provider-connected";

export interface ProviderConnectedEventDetail {
  provider: string;
  kind: "api-key" | "oauth";
}

declare global {
  interface WindowEventMap {
    [PROVIDER_CONNECTED_EVENT]: CustomEvent<ProviderConnectedEventDetail>;
  }
}

export type LlmCredentialState = {
  apiKeys: LocalLlmCredentialSummary[];
  oauthProviders: LocalLlmOAuthProviderSummary[];
  oauthCredentials: LocalLlmCredentialSummary[];
  loading: boolean;
  error: string | null;
};

export type LlmCredentialActions = {
  reload: () => Promise<void>;
  saveApiKey: (
    provider: string,
    label: string,
    plaintext: string,
  ) => Promise<void>;
  removeApiKey: (provider: string) => Promise<void>;
  loginOAuth: (provider: string) => Promise<void>;
  logoutOAuth: (provider: string) => Promise<void>;
};

export type LlmCredentials = LlmCredentialState & LlmCredentialActions;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Module-level cache so that re-mounts (e.g. switching between the Image
 * and Voice tabs, which each mount their own `ProviderOnlyPicker`) start
 * with the last-known credential state instead of empty arrays. Without
 * this the rows flash "Connect" -> "Connected" on every tab switch while
 * the background `listLlmCredentials` IPC resolves.
 */
const credentialsCache: {
  apiKeys: LocalLlmCredentialSummary[];
  oauthProviders: LocalLlmOAuthProviderSummary[];
  oauthCredentials: LocalLlmCredentialSummary[];
  hydrated: boolean;
} = {
  apiKeys: [],
  oauthProviders: [],
  oauthCredentials: [],
  hydrated: false,
};

/**
 * Single source of truth for the local LLM credential surface. Every model
 * picker / settings view that needs to know which providers are signed in
 * shares this hook so we don't hand-roll the same `listLlmCredentials` /
 * `listLlmOAuthCredentials` plumbing in three places.
 */
export function useLlmCredentials(): LlmCredentials {
  const [apiKeys, setApiKeys] = useState<LocalLlmCredentialSummary[]>(
    credentialsCache.apiKeys,
  );
  const [oauthProviders, setOauthProviders] = useState<
    LocalLlmOAuthProviderSummary[]
  >(credentialsCache.oauthProviders);
  const [oauthCredentials, setOauthCredentials] = useState<
    LocalLlmCredentialSummary[]
  >(credentialsCache.oauthCredentials);
  const [loading, setLoading] = useState(!credentialsCache.hydrated);
  const [error, setError] = useState<string | null>(null);
  const knownConnectedRef = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.listLlmCredentials) {
      setApiKeys([]);
      setOauthProviders([]);
      setOauthCredentials([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [keys, providers, oauth] = await Promise.all([
        systemApi.listLlmCredentials(),
        systemApi.listLlmOAuthProviders?.() ?? Promise.resolve([]),
        systemApi.listLlmOAuthCredentials?.() ?? Promise.resolve([]),
      ]);
      setApiKeys(keys);
      setOauthProviders(providers);
      setOauthCredentials(oauth);
      credentialsCache.apiKeys = keys;
      credentialsCache.oauthProviders = providers;
      credentialsCache.oauthCredentials = oauth;
      credentialsCache.hydrated = true;
      // Seed the "known connected" set so subsequent save/login transitions
      // only fire when a provider goes from absent -> present in this
      // session. Without this we'd false-positive every time the hook
      // re-mounts against an already-authenticated provider.
      const seeded = new Set<string>();
      for (const entry of keys) {
        if (entry.status === "active") seeded.add(entry.provider);
      }
      for (const entry of oauth) {
        if (entry.status === "active") seeded.add(entry.provider);
      }
      knownConnectedRef.current = seeded;
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Failed to load local API keys."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveApiKey = useCallback(
    async (provider: string, label: string, plaintext: string) => {
      if (!window.electronAPI?.system?.saveLlmCredential) {
        throw new Error("Local API key storage is unavailable in this window.");
      }
      const wasConnected = knownConnectedRef.current.has(provider);
      const saved = await window.electronAPI.system.saveLlmCredential({
        provider,
        label,
        plaintext,
      });
      setApiKeys((prev) => {
        const next = prev.filter((entry) => entry.provider !== saved.provider);
        next.push(saved);
        next.sort((a, b) => a.label.localeCompare(b.label));
        credentialsCache.apiKeys = next;
        return next;
      });
      knownConnectedRef.current.add(provider);
      if (!wasConnected) {
        window.dispatchEvent(
          new CustomEvent<ProviderConnectedEventDetail>(
            PROVIDER_CONNECTED_EVENT,
            { detail: { provider, kind: "api-key" } },
          ),
        );
      }
    },
    [],
  );

  const removeApiKey = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.deleteLlmCredential) {
      throw new Error("Local API key storage is unavailable in this window.");
    }
    await window.electronAPI.system.deleteLlmCredential(provider);
    setApiKeys((prev) => {
      const next = prev.filter((entry) => entry.provider !== provider);
      credentialsCache.apiKeys = next;
      return next;
    });
    knownConnectedRef.current.delete(provider);
  }, []);

  const loginOAuth = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.loginLlmOAuthCredential) {
      throw new Error("OAuth login is unavailable in this window.");
    }
    const wasConnected = knownConnectedRef.current.has(provider);
    const saved =
      await window.electronAPI.system.loginLlmOAuthCredential(provider);
    setOauthCredentials((prev) => {
      const next = prev.filter((entry) => entry.provider !== saved.provider);
      next.push(saved);
      next.sort((a, b) => a.label.localeCompare(b.label));
      credentialsCache.oauthCredentials = next;
      return next;
    });
    knownConnectedRef.current.add(provider);
    if (!wasConnected) {
      window.dispatchEvent(
        new CustomEvent<ProviderConnectedEventDetail>(
          PROVIDER_CONNECTED_EVENT,
          { detail: { provider, kind: "oauth" } },
        ),
      );
    }
  }, []);

  const logoutOAuth = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.deleteLlmOAuthCredential) {
      throw new Error("OAuth login is unavailable in this window.");
    }
    await window.electronAPI.system.deleteLlmOAuthCredential(provider);
    setOauthCredentials((prev) => {
      const next = prev.filter((entry) => entry.provider !== provider);
      credentialsCache.oauthCredentials = next;
      return next;
    });
    knownConnectedRef.current.delete(provider);
  }, []);

  return {
    apiKeys,
    oauthProviders,
    oauthCredentials,
    loading,
    error,
    reload,
    saveApiKey,
    removeApiKey,
    loginOAuth,
    logoutOAuth,
  };
}

export const findApiKey = (
  credentials: readonly LocalLlmCredentialSummary[],
  provider: string,
) =>
  credentials.find(
    (credential) =>
      credential.provider === provider && credential.status === "active",
  );

export const findOauthProvider = (
  providers: readonly LocalLlmOAuthProviderSummary[],
  provider: string,
) => providers.find((entry) => entry.provider === provider);

export const findOauthCredential = (
  credentials: readonly LocalLlmCredentialSummary[],
  provider: string,
) =>
  credentials.find(
    (credential) =>
      credential.provider === provider && credential.status === "active",
  );
