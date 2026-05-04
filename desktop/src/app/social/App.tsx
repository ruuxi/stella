import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { SocialView } from "@/app/social/SocialView";

type SocialSearch = {
  dialog?: "auth" | "connect";
};

export function SocialApp() {
  const navigate = useNavigate();

  const onSignIn = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: SocialSearch) => ({
        ...(prev ?? {}),
        dialog: "auth" as const,
      }),
    });
  }, [navigate]);

  return <SocialView onSignIn={onSignIn} />;
}
