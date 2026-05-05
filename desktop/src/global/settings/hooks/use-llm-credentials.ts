import { useCallback, useEffect, useState } from "react";
import type {
  LocalLlmCredentialSummary,
  LocalLlmOAuthProviderSummary,
} from "@/shared/types/electron";

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
 * Single source of truth for the local LLM credential surface. Every model
 * picker / settings view that needs to know which providers are signed in
 * shares this hook so we don't hand-roll the same `listLlmCredentials` /
 * `listLlmOAuthCredentials` plumbing in three places.
 */
export function useLlmCredentials(): LlmCredentials {
  const [apiKeys, setApiKeys] = useState<LocalLlmCredentialSummary[]>([]);
  const [oauthProviders, setOauthProviders] = useState<
    LocalLlmOAuthProviderSummary[]
  >([]);
  const [oauthCredentials, setOauthCredentials] = useState<
    LocalLlmCredentialSummary[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      const saved = await window.electronAPI.system.saveLlmCredential({
        provider,
        label,
        plaintext,
      });
      setApiKeys((prev) => {
        const next = prev.filter((entry) => entry.provider !== saved.provider);
        next.push(saved);
        return next.sort((a, b) => a.label.localeCompare(b.label));
      });
    },
    [],
  );

  const removeApiKey = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.deleteLlmCredential) {
      throw new Error("Local API key storage is unavailable in this window.");
    }
    await window.electronAPI.system.deleteLlmCredential(provider);
    setApiKeys((prev) => prev.filter((entry) => entry.provider !== provider));
  }, []);

  const loginOAuth = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.loginLlmOAuthCredential) {
      throw new Error("OAuth login is unavailable in this window.");
    }
    const saved =
      await window.electronAPI.system.loginLlmOAuthCredential(provider);
    setOauthCredentials((prev) => {
      const next = prev.filter((entry) => entry.provider !== saved.provider);
      next.push(saved);
      return next.sort((a, b) => a.label.localeCompare(b.label));
    });
  }, []);

  const logoutOAuth = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.deleteLlmOAuthCredential) {
      throw new Error("OAuth login is unavailable in this window.");
    }
    await window.electronAPI.system.deleteLlmOAuthCredential(provider);
    setOauthCredentials((prev) =>
      prev.filter((entry) => entry.provider !== provider),
    );
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
