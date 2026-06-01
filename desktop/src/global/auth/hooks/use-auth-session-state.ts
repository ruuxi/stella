import { useMemo } from "react";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";

type AuthSessionUser = {
  email?: string | null;
  name?: string | null;
  isAnonymous?: boolean | null;
} | null;

type AuthSessionData = {
  user?: AuthSessionUser;
  session?: {
    id?: string | null;
  } | null;
} | null | undefined;

export function useAuthSessionState() {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasSession = Boolean(sessionData);
  const isAnonymous = user?.isAnonymous === true;
  const hasConnectedAccount = hasSession && !isAnonymous;
  const cacheScope = !hasSession
    ? "signed-out"
    : isAnonymous
      ? `anonymous:${sessionData?.session?.id ?? "unknown"}`
      : `account:${user?.email ?? user?.name ?? sessionData?.session?.id ?? "unknown"}`;

  return useMemo(
    () => ({
      user,
      hasSession,
      isAnonymous,
      hasConnectedAccount,
      isLoading: Boolean(session.isPending),
      cacheScope,
    }),
    [
      cacheScope,
      hasConnectedAccount,
      hasSession,
      isAnonymous,
      session.isPending,
      user,
    ],
  );
}
