import { useState, useEffect, useRef, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { getSetCookie } from "@convex-dev/better-auth/client/plugins";
import { authClient } from "@/global/auth/lib/auth-client";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";

/** Same key as `crossDomainClient()` default in `auth-client.ts`. */
const BETTER_AUTH_COOKIE_STORAGE_KEY = "better-auth_cookie";

type Status = "idle" | "sending" | "sent" | "verifying" | "error";

const POLL_INTERVAL_MS = 2500;

interface UseMagicLinkAuthResult {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  status: Status;
  error: string | null;
  handleMagicLinkSubmit: (event: FormEvent) => Promise<void>;
  reset: () => void;
}

const getConvexSiteUrl = () => {
  const url = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!url) {
    throw new Error("Convex site URL is not configured.");
  }
  return url;
};

export const useMagicLinkAuth = (): UseMagicLinkAuthResult => {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const handleMagicLinkSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();

    if (!trimmed) {
      setError("Enter an email address.");
      return;
    }

    setError(null);
    setStatus("sending");

    try {
      const convexSiteUrl = getConvexSiteUrl();
      const response = await fetch(`${convexSiteUrl}/api/auth/link/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = (await response.json()) as {
        requestId?: string;
        error?: string;
      };
      if (!response.ok || !data.requestId) {
        throw new Error(data.error || "Failed to send sign-in email.");
      }
      setRequestId(data.requestId);
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to send magic link.");
    }
  };

  // Poll for magic link verification.
  useEffect(() => {
    if (status !== "sent" || !requestId) return;
    cancelledRef.current = false;
    const convexSiteUrl = getConvexSiteUrl();

    const poll = async () => {
      while (!cancelledRef.current) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;

        try {
          const res = await fetch(
            `${convexSiteUrl}/api/auth/link/status?requestId=${encodeURIComponent(requestId)}`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as {
            status: string;
            ott?: string;
            sessionCookie?: string;
          };

          if (data.status === "completed" && data.sessionCookie) {
            if (cancelledRef.current) return;
            setStatus("verifying");
            try {
              const prev = localStorage.getItem(BETTER_AUTH_COOKIE_STORAGE_KEY);
              const merged = getSetCookie(data.sessionCookie, prev ?? undefined);
              localStorage.setItem(BETTER_AUTH_COOKIE_STORAGE_KEY, merged);
              // Notify the session signal so useSession() re-fetches
              const store = (authClient as unknown as { $store?: { notify: (s: string) => void } }).$store;
              if (store) {
                store.notify("$sessionSignal");
              } else {
                await authClient.getSession();
              }
            } catch {
              setStatus("error");
              setError("Could not finish sign-in. Please try again.");
              setRequestId(null);
            }
            return;
          }

          if (data.status === "completed") {
            if (cancelledRef.current) return;
            setStatus("error");
            setError("Sign-in incomplete. Please try again.");
            setRequestId(null);
            return;
          }

          if (data.status === "expired") {
            if (cancelledRef.current) return;
            setStatus("error");
            setError("Sign-in link expired. Please try again.");
            setRequestId(null);
            return;
          }
        } catch {
          // Retry silently on network errors.
        }
      }
    };

    void poll();
    return () => {
      cancelledRef.current = true;
    };
  }, [status, requestId]);

  const reset = () => {
    cancelledRef.current = true;
    setEmail("");
    setStatus("idle");
    setError(null);
    setRequestId(null);
  };

  return {
    email,
    setEmail,
    status,
    error,
    handleMagicLinkSubmit,
    reset,
  };
};
