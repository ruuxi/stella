import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";

export type SocialProfile = {
  ownerId: string;
  nickname: string;
  avatarUrl?: string;
  friendCode: string;
};

export function useSocialProfile() {
  const { hasConnectedAccount } = useAuthSessionState();

  const profile = useQuery(
    api.social.profiles.getMyProfile,
    hasConnectedAccount ? {} : "skip",
  ) as SocialProfile | undefined;

  const ensureProfileMutation = useMutation(api.social.profiles.ensureProfile);
  const updateProfileMutation = useMutation(api.social.profiles.updateMyProfile);

  const ensureProfile = useCallback(async () => {
    return await ensureProfileMutation();
  }, [ensureProfileMutation]);

  const updateNickname = useCallback(
    async (nickname: string) => {
      return await updateProfileMutation({ nickname });
    },
    [updateProfileMutation],
  );

  return {
    profile: profile ?? null,
    isSignedIn: hasConnectedAccount,
    ensureProfile,
    updateNickname,
  };
}
