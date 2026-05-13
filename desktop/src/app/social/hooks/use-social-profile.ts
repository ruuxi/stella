import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";

export type SocialProfile = {
  ownerId: string;
  username: string;
  avatarUrl?: string;
};

export function useSocialProfile() {
  const { hasConnectedAccount } = useAuthSessionState();

  const profile = useQuery(
    api.social.profiles.getMyProfile,
    hasConnectedAccount ? {} : "skip",
  ) as SocialProfile | undefined;

  const ensureProfileMutation = useMutation(api.social.profiles.ensureProfile);
  const claimUsernameMutation = useMutation(api.social.profiles.claimUsername);

  const ensureProfile = useCallback(async () => {
    return await ensureProfileMutation();
  }, [ensureProfileMutation]);

  const claimUsername = useCallback(
    async (username: string) => {
      return await claimUsernameMutation({ username });
    },
    [claimUsernameMutation],
  );

  return {
    profile: profile ?? null,
    isSignedIn: hasConnectedAccount,
    ensureProfile,
    claimUsername,
  };
}
