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

  return useMemo(
    () => ({
      user,
      hasSession,
      isAnonymous,
      hasConnectedAccount,
      isLoading: Boolean(session.isPending),
    }),
    [hasConnectedAccount, hasSession, isAnonymous, session.isPending, user],
  );
}
