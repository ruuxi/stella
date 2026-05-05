import { ConvexClient } from "convex/browser";
import type { RunnerContext } from "./types.js";
import {
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
} from "./shared.js";

export const createConvexSession = (
  context: RunnerContext,
  options: {
    onAuthTokenSet?: () => void;
    /** Called before clearing auth so the client can still authenticate (e.g. goOffline). */
    onBeforeAuthTokenClear?: () => void | Promise<void>;
  } = {},
) => {
  const disposeConvexClient = () => {
    const client = context.state.convexClient;
    context.state.convexClient = null;
    context.state.convexClientUrl = null;
    if (client) {
      void client.close().catch(() => undefined);
    }
  };

  const ensureConvexClient = (): ConvexClient | null => {
    const deploymentUrl = sanitizeConvexDeploymentUrl(
      context.state.convexDeploymentUrl,
    );
    if (!deploymentUrl) {
      disposeConvexClient();
      return null;
    }

    if (
      context.state.convexClient &&
      context.state.convexClientUrl === deploymentUrl
    ) {
      return context.state.convexClient;
    }

    disposeConvexClient();
    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => context.state.authToken?.trim() || null);
    context.state.convexClient = client;
    context.state.convexClientUrl = deploymentUrl;
    return client;
  };

  const ensureStellaSiteReady = (): { baseUrl: string; authToken: string } => {
    const baseUrl = sanitizeStellaBase(context.state.convexSiteUrl);
    const nextAuthToken = context.state.authToken?.trim();
    if (!baseUrl) {
      throw new Error(
        "Stella runtime is missing site URL. Set STELLA_LLM_PROXY_URL or configure host URL.",
      );
    }
    if (!nextAuthToken) {
      throw new Error(
        "Stella runtime is missing auth token. Sign in or set STELLA_LLM_PROXY_TOKEN.",
      );
    }
    return { baseUrl, authToken: nextAuthToken };
  };

  const webSearch = async (
    query: string,
    optionsArg?: { category?: string },
  ): Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }> => {
    try {
      const client = ensureConvexClient();
      if (!client)
        throw new Error(
          "Not connected to Convex. Sign in or set STELLA_CONVEX_URL.",
        );
      const result = (await (client as any).action(
        (
          context.convexApi as {
            agent: { local_runtime: { webSearch: unknown } };
          }
        ).agent.local_runtime.webSearch,
        {
          query,
          ...(optionsArg?.category ? { category: optionsArg.category } : {}),
        },
      )) as {
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      };

      return {
        text: result.text || "WebSearch returned no response.",
        results: result.results,
      };
    } catch (error) {
      return {
        text: `WebSearch failed: ${(error as Error).message}`,
        results: [],
      };
    }
  };

  const ensureStoreClient = (): ConvexClient => {
    const client = ensureConvexClient();
    if (!client) {
      throw new Error(
        "Not connected to Convex. Sign in or set STELLA_CONVEX_URL.",
      );
    }
    return client;
  };

  const setConvexUrl = (value: string | null) => {
    if (!process.env.STELLA_CONVEX_URL) {
      const nextConvexDeploymentUrl = sanitizeConvexDeploymentUrl(value);
      if (nextConvexDeploymentUrl !== context.state.convexClientUrl) {
        disposeConvexClient();
      }
      context.state.convexDeploymentUrl = nextConvexDeploymentUrl;
    }
    if (!process.env.STELLA_LLM_PROXY_URL) {
      context.state.convexSiteUrl = sanitizeStellaBase(value);
    }
  };

  const setConvexSiteUrl = (value: string | null) => {
    if (process.env.STELLA_LLM_PROXY_URL) return;
    context.state.convexSiteUrl = sanitizeStellaBase(value);
  };

  const setAuthToken = (
    value: string | null,
    setOptions: { forceReconnect?: boolean } = {},
  ) => {
    if (process.env.STELLA_LLM_PROXY_TOKEN) return;
    const prev = context.state.authToken?.trim() || null;
    const next = value?.trim() || null;
    if (next === prev && !setOptions.forceReconnect) return;

    const needsClear = Boolean(prev);
    const applyNew = () => {
      context.state.authToken = value;
      // Recreate the client so background subscriptions reconnect with fresh auth.
      disposeConvexClient();
      if (next) {
        options.onAuthTokenSet?.();
      }
    };

    if (needsClear) {
      void Promise.resolve(options.onBeforeAuthTokenClear?.()).finally(applyNew);
    } else {
      applyNew();
    }
  };

  const setCloudSyncEnabled = (enabled: boolean) => {
    context.state.cloudSyncEnabled = Boolean(enabled);
  };

  const setModelCatalogUpdatedAt = (value: number | null) => {
    context.state.modelCatalogUpdatedAt =
      typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const setHasConnectedAccount = (value: boolean) => {
    context.state.hasConnectedAccount = Boolean(value);
  };

  const subscribeQuery = (
    query: unknown,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => {
    const client = ensureConvexClient();
    if (!client) {
      return null;
    }
    const subscription = client.onUpdate(
      query as never,
      args as never,
      onUpdate as never,
      onError,
    );
    return () => {
      subscription.unsubscribe();
    };
  };

  return {
    disposeConvexClient,
    ensureConvexClient,
    ensureStoreClient,
    ensureStellaSiteReady,
    setConvexUrl,
    setConvexSiteUrl,
    setAuthToken,
    setHasConnectedAccount,
    setCloudSyncEnabled,
    setModelCatalogUpdatedAt,
    subscribeQuery,
    getConvexUrl: () => context.state.convexDeploymentUrl,
    getStellaSiteAuth: (): { baseUrl: string; authToken: string } | null => {
      try {
        return ensureStellaSiteReady();
      } catch {
        return null;
      }
    },
    webSearch,
  };
};
