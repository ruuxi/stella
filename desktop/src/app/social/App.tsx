import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { SocialView } from "@/app/social/SocialView";

export function SocialApp() {
  const navigate = useNavigate();

  const onSignIn = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev) => ({
        ...(prev ?? {}),
        dialog: "auth",
      }),
    });
  }, [navigate]);

  return <SocialView onSignIn={onSignIn} />;
}
