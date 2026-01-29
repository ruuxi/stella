import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

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
        const parsed = new URL(url);
        const token = parsed.searchParams.get("ott");
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
