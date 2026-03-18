import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCallback } from "react";

export function useSocialProfile() {
  const { hasConnectedAccount } = useAuthSessionState();

  const profile = useQuery(
    api.social.profiles.getMyProfile,
    hasConnectedAccount ? {} : "skip",
  );

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
