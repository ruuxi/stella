import { useEffect } from "react";
import { authClient } from "@/global/auth/lib/auth-client";

const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;

const STELLA_PROTOCOL = (
  (import.meta.env.VITE_STELLA_PROTOCOL as string | undefined)
    ?.replace("://", "")
    .replace(":", "")
    .trim()
    .toLowerCase() || "stella"
);

const getAllowedProtocols = () => {
  return new Set(["stella", STELLA_PROTOCOL].filter((value): value is string => Boolean(value)));
};

const extractTrustedOtt = (value: string): string | null => {
  const parsed = new URL(value);
  const protocol = parsed.protocol.toLowerCase().replace(/:$/, "");
  if (!getAllowedProtocols().has(protocol)) {
    return null;
  }
  if (parsed.hostname.trim().toLowerCase() !== "auth") {
    return null;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/g, "") || "/";
  if (normalizedPath !== "/" && normalizedPath !== "/auth" && normalizedPath !== "/callback") {
    return null;
  }
  const token = parsed.searchParams.get("ott");
  if (!token || !AUTH_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return token;
};

const verifyOneTimeToken = async (token: string) => {
  await authClient.$fetch("/cross-domain/one-time-token/verify", {
    method: "POST",
    body: { token },
  });
  const updateSession = (authClient as unknown as { updateSession?: () => void }).updateSession;
  if (typeof updateSession === "function") {
    updateSession();
  } else {
    await authClient.getSession();
  }
};

const handleBrowserAuthCallback = () => {
  if (window.electronAPI) return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("client") !== "desktop") return;
  if (window.location.pathname !== "/auth/callback") return;

  const ott = params.get("ott");
  if (!ott || !AUTH_TOKEN_PATTERN.test(ott)) return;

  window.location.href = `${STELLA_PROTOCOL}://auth/callback?ott=${encodeURIComponent(ott)}`;
};

export const AuthDeepLinkHandler = () => {
  useEffect(() => {
    handleBrowserAuthCallback();

    const api = window.electronAPI;
    if (!api?.system.onAuthCallback) {
      return;
    }
    const unsubscribe = api.system.onAuthCallback(async ({ url }) => {
      try {
        const token = extractTrustedOtt(url);
        if (!token) {
          return;
        }
        await verifyOneTimeToken(token);
      } catch (error) {
        console.error("Failed to handle auth callback", error);
      }
    });
    return unsubscribe;
  }, []);

  return null;
};
