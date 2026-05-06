import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { secureSignOut } from "@/global/auth/services/auth";
import {
  SettingsScreen,
  type SettingsTab,
} from "@/global/settings/SettingsView";

export function SettingsApp() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/settings" });

  const handleSignOut = useCallback(() => {
    void navigate({ to: "/chat" });
    void secureSignOut();
  }, [navigate]);

  const handleActiveTabChange = useCallback(
    (tab: SettingsTab) => {
      void navigate({
        to: "/settings",
        search: { tab },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <SettingsScreen
      activeTab={search.tab}
      onActiveTabChange={handleActiveTabChange}
      onSignOut={handleSignOut}
    />
  );
}
