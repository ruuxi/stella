import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { authClient } from "@/global/auth/lib/auth-client";

type Status = "idle" | "sending" | "sent" | "error";

interface UseMagicLinkAuthResult {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  status: Status;
  error: string | null;
  handleMagicLinkSubmit: (event: FormEvent) => Promise<void>;
  reset: () => void;
}

const getSiteUrl = () => {
  const configured = (import.meta.env.VITE_SITE_URL as string | undefined)?.trim();
  if (configured) {
    return configured;
  }
  if (!window.electronAPI) {
    return window.location.origin;
  }
  return "https://stella.sh";
};

const getCallbackUrl = () => new URL("/auth/callback?client=desktop", getSiteUrl()).href;

export const useMagicLinkAuth = (): UseMagicLinkAuthResult => {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

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
      await authClient.$fetch("/sign-in/magic-link", {
        method: "POST",
        body: { email: trimmed, callbackURL: getCallbackUrl() },
      });
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to send magic link.");
    }
  };

  const reset = () => {
    setEmail("");
    setStatus("idle");
    setError(null);
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
