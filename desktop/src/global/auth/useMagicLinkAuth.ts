import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { refreshAuthSession } from "@/global/auth/services/auth-session";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";

type Status = "idle" | "sending" | "sent" | "verifying" | "error";

const POLL_INTERVAL_MS = 2500;
/**
 * Visual cooldown after a successful send. The backend is the source of
 * truth (3/min/email + Retry-After) — this is purely UX so the resend
 * button doesn't look spam-clickable. A 429 will override with the real
 * Retry-After value.
 */
const RESEND_COOLDOWN_MS = 30_000;

interface UseMagicLinkAuthResult {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  status: Status;
  /**
   * The (normalized) email a sign-in link was last sent to, or null if no
   * send has succeeded in this session. When `email` differs from this we
   * treat the form as a fresh send.
   */
  sentToEmail: string | null;
  error: string | null;
  handleMagicLinkSubmit: (event: FormEvent) => Promise<void>;
  resend: () => Promise<void>;
  /** Seconds left before resend is enabled (0 when ready). */
  resendCooldownSeconds: number;
  /** True while the resend network call is in flight. */
  isResending: boolean;
  reset: () => void;
}

const MagicLinkAuthContext = createContext<UseMagicLinkAuthResult | null>(null);

const getConvexSiteUrl = () => {
  const url = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!url) {
    throw new Error("Convex site URL is not configured.");
  }
  return url;
};

function useMagicLinkAuthState(): UseMagicLinkAuthResult {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sentToEmail, setSentToEmail] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [now, setNow] = useState(() => Date.now());
  const [isResending, setIsResending] = useState(false);
  const cancelledRef = useRef(false);

  const sendMagicLink = async (
    targetEmail: string,
    mode: "initial" | "resend",
  ): Promise<boolean> => {
    setError(null);
    if (mode === "initial") setStatus("sending");
    else setIsResending(true);

    try {
      const convexSiteUrl = getConvexSiteUrl();
      const response = await fetch(`${convexSiteUrl}/api/auth/link/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetEmail }),
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterSec = retryAfterHeader
          ? Math.max(1, parseInt(retryAfterHeader, 10) || 1)
          : 60;
        setCooldownUntil(Date.now() + retryAfterSec * 1000);
        setError(
          `Too many requests. Try again in ${retryAfterSec} second${retryAfterSec === 1 ? "" : "s"}.`,
        );
        if (mode === "initial") setStatus("error");
        return false;
      }

      const data = (await response.json()) as {
        requestId?: string;
        error?: string;
      };
      if (!response.ok || !data.requestId) {
        throw new Error(data.error || "Failed to send sign-in email.");
      }
      setRequestId(data.requestId);
      setSentToEmail(targetEmail);
      setStatus("sent");
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      return true;
    } catch (err) {
      if (mode === "initial") setStatus("error");
      setError(
        err instanceof Error ? err.message : "Failed to send magic link.",
      );
      return false;
    } finally {
      if (mode === "resend") setIsResending(false);
    }
  };

  const handleMagicLinkSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();

    if (!trimmed) {
      setError("Enter an email address.");
      return;
    }

    await sendMagicLink(trimmed, "initial");
  };

  const resend = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    if (Date.now() < cooldownUntil) return;
    if (isResending) return;
    await sendMagicLink(trimmed, "resend");
  };

  // Tick every 500ms while a cooldown is active so the visual countdown
  // stays in sync. We stop ticking once the cooldown elapses.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const resendCooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - now) / 1000),
  );

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
              await window.electronAPI?.system.applyAuthSessionCookie?.(
                data.sessionCookie,
              );
              await refreshAuthSession();
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
    setSentToEmail(null);
    setCooldownUntil(0);
    setIsResending(false);
  };

  return {
    email,
    setEmail,
    status,
    sentToEmail,
    error,
    handleMagicLinkSubmit,
    resend,
    resendCooldownSeconds,
    isResending,
    reset,
  };
}

export function MagicLinkAuthProvider({ children }: { children: ReactNode }) {
  const value = useMagicLinkAuthState();
  return createElement(MagicLinkAuthContext.Provider, { value }, children);
}

export const useMagicLinkAuth = (): UseMagicLinkAuthResult => {
  const value = useContext(MagicLinkAuthContext);
  if (!value) {
    throw new Error(
      "useMagicLinkAuth must be used within MagicLinkAuthProvider",
    );
  }
  return value;
};
