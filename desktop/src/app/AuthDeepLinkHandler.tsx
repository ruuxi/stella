import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;

const extractTrustedOtt = (value: string): string | null => {
  const parsed = new URL(value);
  if (parsed.protocol.toLowerCase() !== "stella:") {
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

export const AuthDeepLinkHandler = () => {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onAuthCallback) {
      return;
    }
    const unsubscribe = api.onAuthCallback(async ({ url }) => {
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
