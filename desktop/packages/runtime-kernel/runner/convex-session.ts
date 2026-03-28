import { ConvexClient } from "convex/browser";
import type { RunnerContext } from "./types.js";
import {
  escapeHtml,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
} from "./shared.js";

export const createConvexSession = (
  context: RunnerContext,
  options: {
    syncRemoteTurnBridge: () => void;
    onAuthTokenSet?: () => void;
  },
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

  const refreshConvexAuth = () => {
    if (!context.state.convexClient) {
      return;
    }
    context.state.convexClient.setAuth(
      async () => context.state.authToken?.trim() || null,
    );
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
    optionsArg?: { category?: string; displayResults?: boolean },
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

      if (
        optionsArg?.displayResults &&
        context.displayHtml &&
        result.results.length > 0
      ) {
        const itemsHtml = result.results
          .slice(0, 6)
          .map(
            (resultItem) =>
              `<div style="margin-bottom:12px"><div style="font-size:13px;opacity:0.92"><a href="${resultItem.url}" style="color:var(--foreground);text-decoration:underline;text-underline-offset:2px;text-decoration-color:color-mix(in oklch,var(--foreground) 20%,transparent)">${escapeHtml(resultItem.title)}</a></div><div style="font-size:12px;opacity:0.55;margin-top:2px">${escapeHtml(resultItem.snippet)}</div></div>`,
          )
          .join("");
        context.displayHtml(
          `<div><h2 style="font-family:Georgia,serif;font-size:15px;font-weight:500;opacity:0.92;margin:0 0 12px">${escapeHtml(query)}</h2>${itemsHtml}</div>`,
        );
      }

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
    options.syncRemoteTurnBridge();
  };

  const setAuthToken = (value: string | null) => {
    if (process.env.STELLA_LLM_PROXY_TOKEN) return;
    context.state.authToken = value;
    refreshConvexAuth();
    options.syncRemoteTurnBridge();
    if (value) {
      options.onAuthTokenSet?.();
    }
  };

  const setCloudSyncEnabled = (enabled: boolean) => {
    context.state.cloudSyncEnabled = Boolean(enabled);
    options.syncRemoteTurnBridge();
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
    setAuthToken,
    setCloudSyncEnabled,
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
