import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import type { LegalDocument } from "@/global/legal/legal-text";
import { SettingsPanel } from "@/global/settings/SettingsPanel";
import { SettingsSearch } from "@/global/settings/SettingsSearch";
import { SettingsSearchResults } from "@/global/settings/SettingsSearchResults";
import {
  SETTINGS_TABS,
  type SettingsTab,
} from "@/global/settings/settings-tabs";
import type { ScoredSettingsSearchEntry } from "@/global/settings/lib/settings-search-index";
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
 * Best-effort idle prefetch of every Settings tab chunk. Runs once
 * after the user has been on `/settings` for ~1s, so first paint and
 * the user's first click aren't competing for the network/parser.
 * `requestIdleCallback` waits for the main thread to actually be idle;
 * the timeout cap ensures we still fire on tabs that never hit idle.
 */
function preloadAllSettingsTabsWhenIdle(): () => void {
  let cancelled = false;
  const idleHandle = window.setTimeout(() => {
    if (cancelled) return;
    const schedule = (cb: () => void) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(cb, { timeout: 2000 });
      } else {
        window.setTimeout(cb, 0);
      }
    };
    for (const tab of Object.keys(TAB_PRELOADERS) as SettingsTab[]) {
      schedule(() => {
        if (cancelled) return;
        preloadTab(tab);
      });
    }
  }, 1000);
  return () => {
    cancelled = true;
    window.clearTimeout(idleHandle);
  };
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const t = useT();

  const activeTab = activeTabProp ?? selectedTab;

  // Defer the value used for filtering work. Keeps the input
  // responsive even on slower machines while the results list catches
  // up. For our small catalog the win is marginal but the primitive
  // costs nothing.
  const deferredQuery = useDeferredValue(searchQuery);
  const isSearching = deferredQuery.trim().length > 0;

  const handleTabClick = useCallback(
    (next: SettingsTab) => {
      if (activeTabProp === undefined) {
        setSelectedTab(next);
      }
      onActiveTabChange?.(next);
    },
    [activeTabProp, onActiveTabChange],
  );

  // After picking a search result we need to (1) switch tabs and (2)
  // scroll the matching card into view + briefly highlight it. The tab
  // mount is async (Suspense), so we hand a "pending target" to the
  // panel and let it resolve once the right cards are in the DOM.
  const [pendingScrollTarget, setPendingScrollTarget] = useState<{
    tab: SettingsTab;
    title: string;
    nonce: number;
  } | null>(null);

  const handleResultSelect = useCallback(
    (result: ScoredSettingsSearchEntry) => {
      setSearchQuery("");
      handleTabClick(result.tab);
      setPendingScrollTarget({
        tab: result.tab,
        // Row-level entries carry `cardTitle` for the actual card to
        // scroll to; card-level entries scroll to their own title.
        title: result.cardTitle ?? result.title,
        // Nonce ensures repeat-selecting the same result re-triggers
        // the scroll/highlight effect even when tab + title are equal.
        nonce: Date.now(),
      });
    },
    [handleTabClick],
  );

  // Edge fade is on the horizontal tab strip itself — that's where the
  // scrollable overflow lives now that the rail is laid out as a row.
  const tabStripRef = useEdgeFadeRef<HTMLElement>();

  // Once the user lands on /settings, prefetch every tab chunk during
  // browser idle time. Tab switches become instant from then on and
  // first paint isn't competing with the prefetch.
  useEffect(() => preloadAllSettingsTabsWhenIdle(), []);

  return (
    <>
      {/* The Settings page owns its own left rail rather than borrowing
          the global sidebar's slot — keeps Settings self-contained and
          leaves the shell sidebar untouched while /settings is open. */}
      <div
        className="settings-screen"
        data-search-active={isSearching ? "true" : "false"}
      >
        <div className="settings-layout settings-layout--standalone">
          {/* Header: title row above, then horizontal tab strip. No
              side rail — keeps the page visually centered and gives
              the panel content the full width to breathe. */}
          <header
            className="settings-tab-rail"
            role="tablist"
            aria-label={t("settings.title")}
          >
            <div className="settings-tab-rail-header">
              <div className="settings-tab-rail-title">
                {t("settings.title")}
              </div>
              <SettingsSearch value={searchQuery} onChange={setSearchQuery} />
            </div>
            <nav ref={tabStripRef} className="settings-tab-rail-nav">
              {SETTINGS_TABS.map((tab) => {
                const isActive = activeTab === tab.key && !isSearching;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`settings-tab-rail-item${isActive ? " settings-tab-rail-item--active" : ""}`}
                    onClick={() => {
                      if (isSearching) setSearchQuery("");
                      handleTabClick(tab.key);
                    }}
                    onFocus={() => preloadTab(tab.key)}
                    onMouseEnter={() => preloadTab(tab.key)}
                  >
                    {t(tab.labelKey)}
                  </button>
                );
              })}
            </nav>
          </header>
          <SettingsPanel>
            {isSearching ? (
              <SettingsSearchResults
                query={deferredQuery}
                onSelect={handleResultSelect}
                onClear={() => setSearchQuery("")}
              />
            ) : (
              <SettingsTabContent
                activeTab={activeTab}
                onSignOut={onSignOut}
                onOpenLegal={setActiveLegalDoc}
                pendingScrollTarget={pendingScrollTarget}
                onScrollTargetHandled={() => setPendingScrollTarget(null)}
              />
            )}
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

interface SettingsTabContentProps {
  activeTab: SettingsTab;
  onSignOut?: () => void;
  onOpenLegal: (doc: LegalDocument) => void;
  pendingScrollTarget: {
    tab: SettingsTab;
    title: string;
    nonce: number;
  } | null;
  onScrollTargetHandled: () => void;
}

function SettingsTabContent({
  activeTab,
  onSignOut,
  onOpenLegal,
  pendingScrollTarget,
  onScrollTargetHandled,
}: SettingsTabContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Resolve any pending "scroll to / highlight this card" request from
  // the search results. Tab content mounts asynchronously through
  // Suspense, so we use a short-lived MutationObserver to wait for the
  // matching card to appear, then scroll + flash it.
  useEffect(() => {
    if (!pendingScrollTarget) return;
    if (pendingScrollTarget.tab !== activeTab) return;
    const container = contentRef.current;
    if (!container) return;

    let cancelled = false;
    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;
    let highlightTimeoutId: number | null = null;

    const tryResolve = (): boolean => {
      const cards = container.querySelectorAll<HTMLElement>(".settings-card");
      const titleNeedle = pendingScrollTarget.title.toLowerCase().trim();
      for (const card of cards) {
        const heading = card.querySelector(".settings-card-title");
        const headingText = (heading?.textContent ?? "").toLowerCase().trim();
        if (headingText === titleNeedle) {
          card.scrollIntoView({ behavior: "smooth", block: "start" });
          card.setAttribute("data-search-target", "true");
          highlightTimeoutId = window.setTimeout(() => {
            card.removeAttribute("data-search-target");
          }, 1800);
          onScrollTargetHandled();
          return true;
        }
      }
      return false;
    };

    if (tryResolve()) {
      return () => {
        if (highlightTimeoutId) window.clearTimeout(highlightTimeoutId);
      };
    }

    observer = new MutationObserver(() => {
      if (cancelled) return;
      if (tryResolve()) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(container, { subtree: true, childList: true });

    // Belt-and-suspenders: stop waiting after a couple seconds so we
    // don't leak observers if the title text changes or content fails
    // to mount.
    timeoutId = window.setTimeout(() => {
      cancelled = true;
      observer?.disconnect();
      observer = null;
      onScrollTargetHandled();
    }, 2500);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (timeoutId) window.clearTimeout(timeoutId);
      if (highlightTimeoutId) window.clearTimeout(highlightTimeoutId);
    };
  }, [activeTab, pendingScrollTarget, onScrollTargetHandled]);

  return (
    <div ref={contentRef} className="settings-panel-content">
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
          <AccountTab onSignOut={onSignOut} onOpenLegal={onOpenLegal} />
        ) : activeTab === "models" ? (
          <ModelsTab />
        ) : activeTab === "audio" ? (
          <AudioTab />
        ) : (
          <BasicTab />
        )}
      </Suspense>
    </div>
  );
}
