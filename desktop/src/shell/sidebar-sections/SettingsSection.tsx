import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useActiveSidebarSection } from "@/features/workspace-display/sidebar-sections";
import { secureSignOut } from "@/global/auth/services/auth";

const SettingsScreen = lazy(() =>
  import("@/global/settings/SettingsView").then((module) => ({
    default: module.SettingsScreen,
  })),
);

export function SettingsSection() {
  const active = useActiveSidebarSection() === "settings";
  const [hasOpened, setHasOpened] = useState(active);

  useEffect(() => {
    if (active) setHasOpened(true);
  }, [active]);

  const handleSignOut = useCallback(() => {
    void secureSignOut();
  }, []);

  if (!hasOpened && !active) return null;

  return (
    <Suspense fallback={null}>
      <SettingsScreen embedded onSignOut={handleSignOut} />
    </Suspense>
  );
}
