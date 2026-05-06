import { lazy, Suspense, useCallback, useState } from "react";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import type { LegalDocument } from "@/global/legal/legal-text";
import { SettingsPanel } from "@/global/settings/SettingsPanel";
import {
  SETTINGS_TABS,
  type SettingsTab,
} from "@/global/settings/settings-tabs";
import { useT } from "@/shared/i18n";
import "@/global/settings/settings.css";

// Each tab is its own chunk. Settings open is dominated by parse cost of
// whichever tab the user actually lands on — lazy-loading them shrinks the
// shell chunk to ~100 lines and lets us prefetch the active tab on hover.
const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({
    default: m.LegalDialog,
  })),
);
const BasicTab = lazy(() =>
  import("./tabs/BasicTab").then((m) => ({ default: m.BasicTab })),
);
const ShortcutsTab = lazy(() =>
  import("./tabs/ShortcutsTab").then((m) => ({ default: m.ShortcutsTab })),
);
const MemoryTab = lazy(() =>
  import("./tabs/MemoryTab").then((m) => ({ default: m.MemoryTab })),
);
const BackupTab = lazy(() =>
  import("./tabs/BackupTab").then((m) => ({ default: m.BackupTab })),
);
const AccountTab = lazy(() =>
  import("./tabs/AccountTab").then((m) => ({ default: m.AccountTab })),
);
const ModelsTab = lazy(() =>
  import("./tabs/ModelsTab").then((m) => ({ default: m.ModelsTab })),
);
const AudioTab = lazy(() =>
  import("@/global/settings/AudioTab").then((m) => ({
    default: m.AudioTab,
  })),
);

// ---------------------------------------------------------------------------
// SettingsScreen (route-mounted, no Dialog wrapper)
// ---------------------------------------------------------------------------

export type { SettingsTab };

interface SettingsScreenProps {
  /** Tab currently in view. When omitted, defaults to basic. */
  activeTab?: SettingsTab;
  /** Called when the user clicks a different tab in the sidebar. */
  onActiveTabChange?: (tab: SettingsTab) => void;
  /** Called when the user signs out from the Basic tab. */
  onSignOut?: () => void;
}

const TAB_PRELOADERS: Record<SettingsTab, () => Promise<unknown>> = {
  basic: () => import("./tabs/BasicTab"),
  shortcuts: () => import("./tabs/ShortcutsTab"),
  memory: () => import("./tabs/MemoryTab"),
  backup: () => import("./tabs/BackupTab"),
  account: () => import("./tabs/AccountTab"),
  models: () => import("./tabs/ModelsTab"),
  audio: () => import("@/global/settings/AudioTab"),
};

const preloadTab = (tab: SettingsTab) => {
  void TAB_PRELOADERS[tab]?.().catch(() => undefined);
};

/**
 * The settings UI rendered inline (no Dialog wrapper). Mounted by the
 * `/settings` route. Tab state can be controlled (via `?tab=...`) or
 * uncontrolled.
 */
export const SettingsScreen = ({
  activeTab: activeTabProp,
  onActiveTabChange,
  onSignOut,
}: SettingsScreenProps) => {
  const [selectedTab, setSelectedTab] = useState<SettingsTab>("basic");
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(
    null,
  );
  const t = useT();

  const activeTab = activeTabProp ?? selectedTab;

  const handleTabClick = useCallback(
    (next: SettingsTab) => {
      if (activeTabProp === undefined) {
        setSelectedTab(next);
      }
      onActiveTabChange?.(next);
    },
    [activeTabProp, onActiveTabChange],
  );

  const tabRailRef = useEdgeFadeRef<HTMLElement>();

  return (
    <>
      {/* The Settings page owns its own left rail rather than borrowing
          the global sidebar's slot — keeps Settings self-contained and
          leaves the shell sidebar untouched while /settings is open. */}
      <div className="settings-screen">
        <div className="settings-layout settings-layout--standalone">
          <aside
            ref={tabRailRef}
            className="settings-tab-rail"
            role="tablist"
            aria-label={t("settings.title")}
          >
            <div className="settings-tab-rail-title">{t("settings.title")}</div>
            <nav className="settings-tab-rail-nav">
              {SETTINGS_TABS.map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`settings-tab-rail-item${isActive ? " settings-tab-rail-item--active" : ""}`}
                    onClick={() => handleTabClick(tab.key)}
                    onFocus={() => preloadTab(tab.key)}
                    onMouseEnter={() => preloadTab(tab.key)}
                  >
                    {t(tab.labelKey)}
                  </button>
                );
              })}
            </nav>
          </aside>
          <SettingsPanel>
            <Suspense fallback={null}>
              {activeTab === "basic" ? (
                <BasicTab />
              ) : activeTab === "shortcuts" ? (
                <ShortcutsTab />
              ) : activeTab === "memory" ? (
                <MemoryTab />
              ) : activeTab === "backup" ? (
                <BackupTab />
              ) : activeTab === "account" ? (
                <AccountTab
                  onSignOut={onSignOut}
                  onOpenLegal={setActiveLegalDoc}
                />
              ) : activeTab === "models" ? (
                <ModelsTab />
              ) : activeTab === "audio" ? (
                <AudioTab />
              ) : (
                <BasicTab />
              )}
            </Suspense>
          </SettingsPanel>
        </div>
      </div>
      <Suspense fallback={null}>
        <LegalDialog
          document={activeLegalDoc}
          onOpenChange={(open) => {
            if (!open) setActiveLegalDoc(null);
          }}
        />
      </Suspense>
    </>
  );
};
