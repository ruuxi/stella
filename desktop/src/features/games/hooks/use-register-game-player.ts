import { useEffect, useRef, useState } from "react";
import { useReducer, useSpacetimeDB } from "spacetimedb/react";
import { reducers } from "@/features/games/bindings";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { getConvexToken } from "@/global/auth/services/auth-token";

const REGISTRATION_RETRY_MS = 3_000;
const DEFAULT_PLAYER_NAME = "Player";

function normalizeDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PLAYER_NAME;
}

export function useRegisterGamePlayer(): void {
  const { isActive, identity, connectionError } = useSpacetimeDB();
  const registerPlayer = useReducer(reducers.registerPlayer);
  const { isLoading, user } = useAuthSessionState();
  const [retryNonce, setRetryNonce] = useState(0);
  const lastRegistrationKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isActive || !identity || isLoading || connectionError) {
      return;
    }

    const displayName = normalizeDisplayName(user?.name);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      const convexToken = await getConvexToken();
      if (cancelled) {
        return;
      }
      if (!convexToken) {
        retryTimer = setTimeout(() => {
          setRetryNonce((value) => value + 1);
        }, REGISTRATION_RETRY_MS);
        return;
      }

      const registrationKey = [
        identity.toHexString(),
        displayName,
        convexToken,
      ].join(":");
      if (lastRegistrationKeyRef.current === registrationKey) {
        return;
      }

      try {
        await registerPlayer({
          convexToken,
          displayName,
        });
        if (!cancelled) {
          lastRegistrationKeyRef.current = registrationKey;
        }
      } catch (error) {
        console.debug(
          "[games] Failed to register SpacetimeDB player:",
          error instanceof Error ? error.message : String(error),
        );
        if (!cancelled) {
          retryTimer = setTimeout(() => {
            setRetryNonce((value) => value + 1);
          }, REGISTRATION_RETRY_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [
    connectionError,
    identity,
    isActive,
    isLoading,
    registerPlayer,
    retryNonce,
    user?.name,
  ]);
}
